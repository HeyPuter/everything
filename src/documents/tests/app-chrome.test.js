// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chordOf, bindable, displayChord, createKeymap, loadBindings, KEYMAP_STORE } from '../src/views/keymap.js';
import { scoreEntry, searchEntries, menuEntries } from '../src/ui/command-index.js';
import { assignKeyTips } from '../src/ui/ribbon-modes.js';
import { parsePageRange } from '../src/views/backstage.js';
import { classicMenus, tidy, MENU_IDS } from '../src/views/classic-menus.js';

vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn(), announce: vi.fn() }));

const key = (code, mods = {}, keyName = null) => ({ code, key: keyName ?? (code.startsWith('Key') ? code.slice(3).toLowerCase() : code.startsWith('Digit') ? code.slice(5) : code), ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods,
  preventDefault: vi.fn(), stopPropagation: vi.fn(), defaultPrevented: false, repeat: false, isComposing: false });

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('keymap', () => {
  it('writes chords portably: Mod is Cmd on a Mac and Ctrl elsewhere', () => {
    expect(chordOf(key('KeyC', { metaKey: true, shiftKey: true }), true)).toBe('Mod+Shift+C');
    expect(chordOf(key('KeyC', { ctrlKey: true, shiftKey: true }), false)).toBe('Mod+Shift+C');
    expect(chordOf(key('KeyV', { metaKey: true, ctrlKey: true }), true)).toBe('Mod+Ctrl+V');
    expect(chordOf(key('Digit5', { ctrlKey: true }), false)).toBe('Mod+5');
    expect(chordOf(key('F4', {}, 'F4'), false)).toBe('F4');
    expect(chordOf(key('ShiftLeft', { shiftKey: true }, 'Shift'), false)).toBeNull();
    expect(chordOf(key('Comma', { metaKey: true }, ','), true)).toBe('Mod+Comma');
  });
  it('accepts only chords with a modifier, or function keys', () => {
    expect(bindable('Mod+K')).toBe(true);
    expect(bindable('F7')).toBe(true);
    expect(bindable('Shift+K')).toBe(false);
    expect(bindable('Tab')).toBe(false);
    expect(displayChord('Mod+Alt+Comma', true)).toBe('Cmd+Option+,');
    expect(displayChord('Mod+Alt+Comma', false)).toBe('Ctrl+Alt+,');
  });
  it('runs defaults, lets user bindings replace and move them, and persists them', () => {
    const ran = [];
    const keymap = createKeymap({ defaults: { copyFormat: ['Mod+Shift+C'] }, run: id => { ran.push(id); }, storage: localStorage, mac: false });
    const event = key('KeyC', { ctrlKey: true, shiftKey: true });
    expect(keymap.handle(event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(keymap.shortcutFor('copyFormat')).toBe('Ctrl+Shift+C');
    keymap.assign('ribbon:home/font/Italic', 'Mod+Shift+C');
    expect(keymap.chordsFor('copyFormat')).toEqual([]);
    expect(keymap.commandFor('Mod+Shift+C')).toBe('ribbon:home/font/Italic');
    keymap.handle(key('KeyC', { ctrlKey: true, shiftKey: true }));
    expect(ran).toEqual(['copyFormat', 'ribbon:home/font/Italic']);
    expect(loadBindings(localStorage)).toEqual({ copyFormat: [], 'ribbon:home/font/Italic': ['Mod+Shift+C'] });
    expect(JSON.parse(localStorage.getItem(KEYMAP_STORE))['ribbon:home/font/Italic']).toEqual(['Mod+Shift+C']);
    keymap.reset();
    expect(keymap.commandFor('Mod+Shift+C')).toBe('copyFormat');
    expect(localStorage.getItem(KEYMAP_STORE)).toBeNull();
  });
  it('lets an unavailable command fall through to the document', () => {
    const keymap = createKeymap({ defaults: { pasteFormat: ['Mod+Shift+V'] }, run: () => false, storage: localStorage, mac: false });
    const event = key('KeyV', { ctrlKey: true, shiftKey: true });
    expect(keymap.handle(event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
  it('ignores stored bindings it cannot use', () => {
    localStorage.setItem(KEYMAP_STORE, JSON.stringify({ a: ['Shift+A', 'Mod+J'], b: 'nope' }));
    expect(loadBindings(localStorage)).toEqual({ a: ['Mod+J'] });
  });
});

describe('command index', () => {
  const entries = [
    { id: 'a', label: 'Bold', path: ['Home', 'Font'] },
    { id: 'b', label: 'Bullets', path: ['Home', 'Paragraph'] },
    { id: 'c', label: 'Insert Table', path: ['Insert', 'Tables'] },
    { id: 'd', label: 'Table Properties', path: ['Table'], disabled: true },
    { id: 'e', label: 'Bold', path: ['Format'] },
  ];
  it('ranks label matches above path matches and drops duplicates', () => {
    expect(searchEntries(entries, 'bo').map(e => e.id)).toEqual(['a']);
    expect(searchEntries(entries, 'table').map(e => e.id)).toEqual(['c', 'd']);
    expect(searchEntries(entries, 'home bul').map(e => e.id)).toEqual(['b']);
    expect(scoreEntry(entries[0], 'zzz')).toBe(0);
  });
  it('lists menu leaves with their paths and leaves out separators and notes', () => {
    const select = vi.fn();
    const list = menuEntries([{ id: 'edit', label: 'Edit', items: () => [{ label: 'Undo', shortcut: 'Ctrl+Z', onSelect: select }, { separator: true },
      { label: 'Clear', items: [{ label: 'Contents', onSelect: select, disabled: true }] }, { note: 'x' }, { header: 'H' }] }]);
    expect(list.map(e => [e.id, e.path.join('/'), e.disabled])).toEqual([['menu:edit/Undo', 'Edit', false], ['menu:edit/Clear/Contents', 'Edit/Clear', true]]);
    expect(list[1].run()).toBe(false);
    expect(list[0].run()).toBe(true);
    expect(select).toHaveBeenCalledTimes(1);
  });
});

describe('KeyTips', () => {
  it('assigns prefix-free codes, initials first', () => {
    const codes = assignKeyTips(['Paste', 'Cut', 'Copy', 'Bold', 'Italic', 'Underline']);
    expect(codes.slice(0, 2)).toEqual(['P', 'C']);
    expect(codes[3]).toBe('B');
    expect(new Set(codes).size).toBe(codes.length);
    const many = assignKeyTips(Array.from({ length: 40 }, (_, i) => `Command ${i}`));
    expect(new Set(many).size).toBe(40);
    for (const code of many) for (const other of many) if (code !== other) expect(other.startsWith(code)).toBe(false);
  });
});

describe('print page ranges', () => {
  it('reads ranges and lists within the document', () => {
    expect(parsePageRange('1-3, 5', 6)).toEqual([1, 2, 3, 5]);
    expect(parsePageRange('2;2', 3)).toEqual([2]);
    expect(parsePageRange('4', 3)).toBeNull();
    expect(parsePageRange('3-1', 3)).toBeNull();
    expect(parsePageRange('a', 3)).toBeNull();
    expect(parsePageRange('', 3)).toBeNull();
  });
});

describe('classic menus', () => {
  const button = (attrs = {}) => Object.assign(document.createElement('button'), attrs);
  const controls = () => {
    const c = {};
    for (const name of ['undo', 'redo', 'find', 'saveButton', 'exportButton', 'templateButton', 'printButton', 'pageSetup', 'insertImage', 'hyperlink', 'bookmarks', 'pageBreak', 'paragraphGeometry',
      'bullets', 'numbers', 'restart', 'paragraphBorders', 'paragraphShading', 'lineSpacingOptions', 'editStyle', 'newStyle', 'imageProperties', 'outline', 'tableProperties', 'rowHeight',
      'cellAlignment', 'cellMargins', 'cellShading', 'cellBorders', 'insertTable']) c[name] = button();
    c.lineSpacing = document.createElement('select');
    c.tableActions = document.createElement('select');
    return c;
  };
  const build = w => classicMenus({ w, c: controls(), a: { hasDocument: () => true, clipboardState: () => ({}) }, local: false, kit: {}, inDocument: x => x, engineReady: () => true,
    focusEditor() {}, tableAction: () => () => {}, tableOption: () => null });
  const labels = items => items.filter(i => !i.separator).map(i => i.label);
  it('offers the nine menus and leaves out commands no module provides', () => {
    const menus = build({});
    expect(menus.map(m => m.id)).toEqual(MENU_IDS);
    const insert = labels(menus.find(m => m.id === 'insert').items());
    expect(insert).toContain('Pictures…');
    expect(insert).not.toContain('Cross-reference…');
    expect(insert).not.toContain('Shapes…');
    const withShapes = labels(build({ openShapes() {}, crossReference() {} }).find(m => m.id === 'insert').items());
    expect(withShapes).toEqual(expect.arrayContaining(['Shapes…', 'Cross-reference…']));
  });
  it('appends the entries feature modules give through extendMenu', () => {
    const menus = build({ wordCount() {}, extendMenu: (id) => id === 'tools' ? [{ label: 'Mail Merge…', onSelect() {} }] : [] });
    const tools = menus.find(m => m.id === 'tools').items();
    expect(tools.at(-1).label).toBe('Mail Merge…');
    expect(tools.at(-2).separator).toBe(true);
    expect(labels(menus.find(m => m.id === 'help').items())).not.toContain('Mail Merge…');
  });
  it('tidies separators', () => {
    expect(tidy([{ separator: true }, null, { label: 'A' }, { separator: true }, { separator: true }, { label: 'B' }, { separator: true }])).toEqual([{ label: 'A' }, { separator: true }, { label: 'B' }]);
  });
});


describe('document context menu shell', () => {
  it('detects the context and appends each context\'s module items', async () => {
    const { openDocumentMenu } = await import('../src/views/document-context-menu.js');
    const { closeMenu } = await import('../src/ui/menu.js');
    const input = document.createElement('textarea'); document.body.append(input);
    const engine = { input, viewOnly: false, session: { history: [], future: [], path: null }, focus() {}, undo() {}, redo() {},
      model: { selectedImage: null, hyperlink: null, hasBodyFields: false, listFormatting: 'bullet', tableContext: { table: {} }, selection: { focus: 0 }, range: [0, 0] } };
    const seen = [];
    const w = { contextMenuItems: context => { seen.push(context); return context === 'table' ? [{ label: 'Sort Table…', onSelect() {} }] : []; } };
    const x = { clipboardState: () => ({ cut: false, copy: false, paste: true }), spellingItems: () => [], cut() {}, copy() {}, paste() {}, pastePlain() {}, paragraphDialog() {}, editLink() {},
      imageItems: () => [], tableItems: () => [{ label: 'Insert row below', onSelect() {} }], commentItems: () => [], print() {} };
    openDocumentMenu({ event: { clientX: 10, clientY: 10, button: 2 }, engine, pkg: {}, w, kit: {}, actions: x });
    expect(seen).toEqual(['list', 'table', 'text']);
    const labels = [...document.querySelectorAll('.menu .menu-label')].map(n => n.firstChild.textContent);
    expect(labels).toEqual(expect.arrayContaining(['Paste', 'Font…', 'Paragraph…', 'Restart Numbering at 1', 'Insert link…', 'Insert row below', 'Sort Table…', 'Print / Save as PDF']));
    closeMenu();
  });
});

describe('status bar', () => {
  it('names languages, hides items on request and remembers the choice', async () => {
    const { createStatusBar, languageName } = await import('../src/views/status-bar.js');
    expect(languageName('fr-FR', 'en')).toBe('French (France)');
    const span = () => document.createElement('span');
    const parts = { stats: span(), words: span(), proofingButton: document.createElement('button'), editingArea: span(), focusButton: document.createElement('button'),
      zoomOut: document.createElement('button'), zoomSlider: document.createElement('input'), zoomIn: document.createElement('button'), textMode: span(), zoomLabel: span() };
    const w = { currentLanguage: () => 'de-DE', isTracking: () => false, canTrack: () => true, toggleTracking() {} };
    const bar = createStatusBar({ w, a: { hasDocument: () => true }, parts, help: span() });
    document.body.append(bar.el);
    bar.refresh();
    expect(bar.el.querySelector('.ed-status-language').textContent).toBe('German (Germany)');
    // Track Changes shows only while tracking, until chosen to stay.
    expect(bar.el.querySelector('.ed-status-track').classList.contains('is-user-hidden')).toBe(true);
    bar.toggle('track');
    expect(bar.el.querySelector('.ed-status-track').classList.contains('is-user-hidden')).toBe(false);
    bar.toggle('words');
    expect(bar.isShown('words')).toBe(false);
    expect(JSON.parse(localStorage.getItem('documents:statusbar'))).toEqual(['words']);
    bar.el.remove();
  });
});

describe('preferences', () => {
  it('applies a toggle at once and switches sections from the keyboard', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    const { openPreferences } = await import('../src/views/preferences.js');
    let on = true;
    const modal = openPreferences({ sections: [
      { id: 'a', label: 'First', controls: [{ type: 'toggle', label: 'Thing', get: () => on, set: v => { on = v; } }] },
      { id: 'b', label: 'Second', controls: [{ type: 'button', label: 'Act', action: 'Go', run: vi.fn() }] },
    ] });
    const toggle = document.querySelector('.pref-body input[role="switch"]');
    toggle.click();
    expect(on).toBe(false);
    document.querySelector('#pref-tab-a').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.querySelector('#pref-tab-b').getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector('.pref-body').textContent).toContain('Act');
    modal.close();
    vi.unstubAllGlobals();
  });
});
