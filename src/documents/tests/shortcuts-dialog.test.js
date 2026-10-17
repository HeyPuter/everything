// @vitest-environment jsdom
import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import { openShortcuts } from '../src/ui/shortcuts.js';
import { MOD_KEY } from '../src/ui/dom.js';

beforeEach(() => { vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {} })); });
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); document.body.className = ''; });

it('lists only chords the canvas editor handles, with alternatives joined by "or"', () => {
  openShortcuts();
  const text = document.querySelector('.modal-panel').textContent;
  for (const promised of ['Small caps', 'Increase font size', 'Column break', 'Update page references', 'Heading 1 to 6', 'Previous or next paragraph', 'Show keyboard shortcuts', 'Paste without formatting', 'Move paragraphs up or down', 'Check spelling', 'Font dialog']) expect(text).toContain(promised);
  for (const gone of ['Focus mode', 'Go to page', 'Insert footnote', 'Comment on the selection', 'Word count', 'Zoom in']) expect(text).not.toContain(gone);
  const redo = [...document.querySelectorAll('.modal-panel dd')].find(dd => dd.textContent === 'Redo').previousElementSibling;
  expect(redo.textContent).toBe(`${MOD_KEY} + Shift + Z or ${MOD_KEY} + Y`);
  expect(redo.querySelectorAll('.kbd')).toHaveLength(5);
  // One chord, one result: Cmd/Ctrl+, is Preferences, so Subscript does not claim it too.
  const chordFor = what => [...document.querySelectorAll('.modal-panel dd')].filter(dd => dd.textContent === what).map(dd => dd.previousElementSibling.textContent);
  expect(chordFor('Subscript')).toEqual([`${MOD_KEY} + =`]);
  // Cmd/Ctrl+Shift+E is Track Changes, not Center; on a Mac Cmd+G is Find Next, not Go To.
  expect(chordFor('Align center')).toEqual([`${MOD_KEY} + E`]);
  expect(chordFor('Go to a page, line, heading, bookmark, table or graphic')).toEqual([`${MOD_KEY === 'Cmd' ? 'Cmd + Option + G' : 'Ctrl + G'} or F5`]);
  expect([...document.querySelectorAll('.modal-panel dt')].filter(dt => dt.textContent.split(' or ').includes(`${MOD_KEY} + ,`)).map(dt => dt.nextElementSibling.textContent)).toEqual(['Preferences']);
});

const chordsFor = (what) => [...document.querySelectorAll('.modal-panel dd')].filter(dd => dd.textContent === what).map(dd => dd.previousElementSibling.textContent);

it('promises only chords that reach the command: Ctrl+, is Preferences, not Subscript', () => {
  openShortcuts();
  expect(chordsFor('Subscript')).toEqual([`${MOD_KEY} + =`]);
  expect(chordsFor('Preferences')).toEqual([`${MOD_KEY} + ,`]);
  expect(chordsFor('Go to a page, line, heading, bookmark, table or graphic')).toEqual(['Ctrl + G or F5']);
});

it('on a Mac lists Go To under Cmd+Option+G, since Cmd+G finds the next match, and names the Option key', async () => {
  vi.resetModules();
  vi.stubGlobal('navigator', { ...navigator, platform: 'MacIntel', userAgent: navigator.userAgent });
  const mac = await import('../src/ui/shortcuts.js');
  mac.openShortcuts();
  expect(chordsFor('Go to a page, line, heading, bookmark, table or graphic')).toEqual(['Cmd + Option + G or F5']);
  expect(chordsFor('Go to')).toEqual([]);
  expect(chordsFor('Find next or previous')).toEqual(['Cmd + G or Cmd + Shift + G or Shift + F4 or Cmd + Shift + F4']);
  expect(chordsFor('Heading 1 to 6')).toEqual(['Cmd + Option + 1 … 6']);
  expect(chordsFor('Move paragraphs up or down')).toEqual(['Ctrl + Shift + Up / Down']);
  expect(document.querySelector('.modal-panel').textContent).not.toMatch(/\bAlt\b/);
});
