// @vitest-environment jsdom
import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAccessibilityPane } from '../src/views/accessibility-pane.js';

beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); });
afterEach(() => vi.useRealTimers());

const picture = { id: 'p1', format: {}, runs: [{ text: '￼', image: { name: 'Picture 1' } }] };
const plain = { id: 'p1', format: {}, runs: [{ text: 'Plain text.' }] };
const engineWith = (paragraphs, revision = 0) => ({ session: { path: null, body: { revision, paragraphs, tables: [], pageSettings: {} } }, focus() {} });

it('does not report a result before the first check has run', () => {
  const engine = engineWith([picture]);
  const pane = createAccessibilityPane({ editor: () => engine, pkg: () => ({}), error: () => {} });
  const before = pane.summary();
  expect(before.label).not.toMatch(/good to go/);
  expect(before.checking).toBe(true);
  vi.advanceTimersByTime(700);
  const after = pane.summary();
  expect(after.label).toBe('Accessibility: 1 error to fix');
  expect(after.checking).toBeFalsy();
  pane.destroy();
});

it('checks a reopened document again, even at the same edit count', () => {
  let engine = engineWith([plain]);
  const pane = createAccessibilityPane({ editor: () => engine, pkg: () => ({}), error: () => {} });
  pane.summary(); vi.advanceTimersByTime(700);
  expect(pane.summary().label).toBe('Accessibility: good to go');
  // A design change reopens the package in a new editor, whose edit count starts again.
  engine = engineWith([picture]);
  expect(pane.summary().label).not.toMatch(/good to go/);
  vi.advanceTimersByTime(700);
  expect(pane.summary().label).toBe('Accessibility: 1 error to fix');
  pane.destroy();
});
