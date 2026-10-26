// @vitest-environment jsdom
import { it, expect, vi } from 'vitest';
import { findReplacePanel } from '../src/views/find-replace.js';

it('searches again only when the document or the search changes, not when the caret moves', () => {
  let version = [1], range = [0, 0];
  const matches = vi.fn(() => [{ start: 0, end: 3, text: 'cat' }, { start: 10, end: 13, text: 'cat' }]);
  const panel = findReplacePanel({ matches, version: () => version, range: () => range, select() {}, highlight() {}, replace() {}, readOnly: () => false, close() {} });
  document.body.append(panel.node);
  panel.open('cat');
  const calls = matches.mock.calls.length;
  range = [10, 13]; panel.refresh();
  expect(panel.node.querySelector('.canvas-find-count').textContent).toBe('2 of 2');
  range = [0, 3]; panel.refresh();
  expect(panel.node.querySelector('.canvas-find-count').textContent).toBe('1 of 2');
  expect(matches.mock.calls.length).toBe(calls);
  version = [2]; panel.refresh();
  expect(matches.mock.calls.length).toBe(calls + 1);
  const query = panel.node.querySelector('[aria-label="Find text"]');
  query.value = 'dog'; panel.refresh();
  expect(matches.mock.calls.length).toBe(calls + 2);
});

it('searches the user\'s selection, not the match it selected, and keeps searching it after a replacement', () => {
  // A tiny document: Replace changes `text`, and matches come from it within the scope's range.
  let text = 'cat A cat B cat C | cat D cat E', range = [0, 17];
  const find = (query, options) => [...text.matchAll(new RegExp(query, 'g'))].map(m => ({ start: m.index, end: m.index + query.length, text: query }))
    .filter(m => !options.within || options.within[0] <= m.start && m.end <= options.within[1]);
  const api = {
    matches: find, range: () => range, textLength: () => text.length, highlight() {}, readOnly: () => false, close() {},
    select: m => { range = [m.start, m.end]; },
    replace: (query, replacement, options) => {
      const m = find(query, options).find(m => m.start === range[0] && m.end === range[1]); if (!m) return 0;
      text = text.slice(0, m.start) + replacement + text.slice(m.end); range = [m.start + replacement.length, m.start + replacement.length]; return 1;
    },
  };
  const panel = findReplacePanel(api);
  document.body.append(panel.node);
  panel.open('', { advanced: true });
  const query = panel.node.querySelector('[aria-label="Find text"]'), scope = panel.node.querySelector('[aria-label="Search in"]');
  query.value = 'cat'; query.dispatchEvent(new Event('input'));
  // Typing selected the first match; the scope is still the selection made before.
  expect(range).toEqual([0, 3]);
  scope.value = 'selection'; scope.dispatchEvent(new Event('change'));
  expect(panel.node.querySelector('.canvas-find-count').textContent).toBe('1 of 3');
  panel.node.querySelector('[aria-label="Replace with"]').value = 'dogs';
  const replaceButton = [...panel.node.querySelectorAll('button')].find(b => b.textContent === 'Replace');
  for (let i = 0; i < 4; i++) if (!replaceButton.disabled) replaceButton.click();
  expect(text).toBe('dogs A dogs B dogs C | cat D cat E');
  expect(scope.value).toBe('selection');
  expect(panel.node.querySelector('.canvas-find-count').textContent).toBe('No matches');
});

it('a closed panel leaves alone the tints of a search it did not make, and clears only its own', () => {
  const highlight = vi.fn();
  const panel = findReplacePanel({ matches: () => [{ start: 0, end: 3, text: 'cat' }], version: () => [1], range: () => [0, 0], select() {}, highlight, replace() {}, readOnly: () => false, close() {} });
  document.body.append(panel.node);
  // Closed from the start: the Navigation pane's search tints the document, and each update leaves them be.
  panel.refresh(); panel.refresh();
  expect(highlight).not.toHaveBeenCalled();
  panel.open('cat');
  expect(highlight).toHaveBeenLastCalledWith([{ start: 0, end: 3, text: 'cat' }]);
  panel.node.querySelector('.canvas-find-heading button').click();
  expect(highlight).toHaveBeenLastCalledWith([]);
  highlight.mockClear();
  panel.refresh();
  expect(highlight).not.toHaveBeenCalled();
});
