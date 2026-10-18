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
