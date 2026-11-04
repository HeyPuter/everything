// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { browserReserved, displayedChordReserved, bindable, createKeymap, loadBindings, KEYMAP_STORE } from '../src/views/keymap.js';

beforeEach(() => { vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {} })); localStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); document.body.replaceChildren(); document.body.className = ''; localStorage.clear(); });

// Headless browsers hand these chords to the page; a real Chrome window keeps them (new tab, close window).
it('knows the chords the browser keeps on each platform', () => {
  for (const chord of ['Mod+T', 'Mod+Shift+T', 'Mod+N', 'Mod+Shift+N', 'Mod+W', 'Mod+Shift+W', 'Mod+F4', 'Alt+F4', 'Mod+Tab']) expect(browserReserved(chord, false), chord).toBe(true);
  for (const chord of ['Mod+B', 'Mod+Alt+T', 'Mod+Shift+M', 'Alt+Shift+W', 'F4', 'Mod+Q']) expect(browserReserved(chord, false), chord).toBe(false);
  // On a Mac the Command forms are taken, the Control forms are free.
  for (const chord of ['Mod+T', 'Mod+Shift+N', 'Mod+W', 'Mod+Q', 'Mod+H', 'Mod+M']) expect(browserReserved(chord, true), chord).toBe(true);
  for (const chord of ['Ctrl+T', 'Ctrl+Shift+N', 'Ctrl+Shift+W', 'Mod+Alt+M', 'Alt+F4']) expect(browserReserved(chord, true), chord).toBe(false);
  // As menus, tooltips and the keyboard sheet write them.
  expect(displayedChordReserved('Ctrl + Shift + W', false)).toBe(true);
  expect(displayedChordReserved('Ctrl+T', false)).toBe(true);
  expect(displayedChordReserved('Ctrl+Shift+N', true)).toBe(false);
  expect(displayedChordReserved('Cmd+Shift+N', true)).toBe(true);
  expect(displayedChordReserved('Ctrl+Alt+0', false)).toBe(false);
  expect(displayedChordReserved('F4', false)).toBe(false);
  expect(displayedChordReserved(null, false)).toBe(false);
});

it('will not bind a chord the browser keeps, nor load one stored by another tab or platform', () => {
  expect(bindable('Mod+T', false)).toBe(false);
  expect(bindable('Ctrl+T', true)).toBe(true);
  localStorage.setItem(KEYMAP_STORE, JSON.stringify({ a: ['Mod+Shift+W', 'Mod+Alt+J'] }));
  expect(loadBindings(localStorage, false)).toEqual({ a: ['Mod+Alt+J'] });
  const keymap = createKeymap({ defaults: {}, run: () => {}, storage: localStorage, mac: false });
  expect(keymap.assign('b', 'Mod+N')).toBe(false);
  expect(keymap.chordsFor('b')).toEqual([]);
  expect(keymap.assign('b', 'Mod+Alt+N')).toBe(true);
});

it('on Windows and Linux the keyboard sheet leaves out Ctrl+T, Ctrl+Shift+N and Ctrl+Shift+W', async () => {
  vi.stubGlobal('navigator', { ...navigator, platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' });
  const { openShortcuts } = await import('../src/ui/shortcuts.js');
  openShortcuts();
  const text = document.querySelector('.modal-panel').textContent;
  expect(text).not.toMatch(/Ctrl \+ T|Ctrl \+ Shift \+ T|Ctrl \+ Shift \+ N|Ctrl \+ Shift \+ W/);
  expect(text).not.toContain('Underline words only');
  expect(text).not.toContain('Hanging indent');
  // Normal style keeps the chord that reaches the page.
  const rows = [...document.querySelectorAll('.modal-panel dd')].filter(dd => dd.textContent === 'Normal style').map(dd => dd.previousElementSibling.textContent);
  expect(rows).toEqual(['Ctrl + Alt + 0']);
});

it('on a Mac the keyboard sheet keeps the Control chords, which reach the page there', async () => {
  vi.stubGlobal('navigator', { ...navigator, platform: 'MacIntel', userAgent: navigator.userAgent });
  const { openShortcuts } = await import('../src/ui/shortcuts.js');
  openShortcuts();
  const chords = what => [...document.querySelectorAll('.modal-panel dd')].filter(dd => dd.textContent === what).map(dd => dd.previousElementSibling.textContent);
  expect(chords('Underline words only')).toEqual(['Ctrl + Shift + W']);
  expect(chords('Hanging indent, or reduce it')).toEqual(['Ctrl + T or Ctrl + Shift + T']);
  expect(chords('Normal style')).toEqual(['Cmd + Option + 0', 'Ctrl + Shift + N']);
});

it('a ribbon command offers no tooltip chord, and lists none for Customize Keyboard, that the browser keeps', async () => {
  vi.stubGlobal('navigator', { ...navigator, platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' });
  const { command } = await import('../src/ui/ribbon.js');
  const toBody = command('Demote to Body Text', 'demoteBody', () => {}, { shortcut: 'Ctrl+Shift+N' });
  expect(toBody.title).toBe('Demote to Body Text');
  expect(toBody.dataset.shortcut).toBeUndefined();
  expect(command('Bold', 'bold', () => {}, { shortcut: 'Ctrl+B' }).title).toBe('Bold (Ctrl+B)');
});

it('Customize Keyboard explains a chord the browser keeps, and will not assign it', async () => {
  const { openCustomizeKeyboard } = await import('../src/views/customize-keyboard.js');
  const keymap = createKeymap({ defaults: {}, run: () => {}, storage: localStorage, mac: false });
  openCustomizeKeyboard({ entries: () => [{ id: 'ribbon:home/font/Underline', label: 'Underline', path: ['Home', 'Font'], shortcut: 'Ctrl+U' }], keymap, select: 'ribbon:home/font/Underline' });
  const capture = document.querySelector('.kb-capture'), assign = [...document.querySelectorAll('button')].find(b => b.textContent === 'Assign');
  const press = init => capture.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  press({ key: 'w', code: 'KeyW', ctrlKey: true, shiftKey: true });
  expect(capture.value).toBe('Ctrl+Shift+W');
  expect(document.querySelector('#kb-capture-hint').textContent).toContain('The browser keeps Ctrl+Shift+W');
  expect(assign.disabled).toBe(true);
  press({ key: 'w', code: 'KeyW', ctrlKey: true, altKey: true });
  expect(assign.disabled).toBe(false);
  // A reserved chord after a good one leaves nothing to assign.
  press({ key: 't', code: 'KeyT', ctrlKey: true });
  expect(assign.disabled).toBe(true);
  assign.click();
  expect(keymap.custom).toEqual({});
});
