// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { openPanel } from '../src/views/references-ui.js';

afterEach(() => document.body.replaceChildren());

it('opens one reference panel at a time, closing the one it would cover', () => {
  const closed = vi.fn();
  openPanel({ title: 'Mark Index Entry', body: [document.createElement('input')], onClose: closed });
  const citation = openPanel({ title: 'Mark Citation', body: [document.createElement('input')] });
  expect([...document.querySelectorAll('.ref-panel')].map(p => p.dataset.title)).toEqual(['Mark Citation']);
  expect(closed).toHaveBeenCalledOnce();
  expect(citation.node.contains(document.activeElement)).toBe(true);
  // Opening the same panel again replaces it.
  openPanel({ title: 'Mark Citation', body: [] });
  expect(document.querySelectorAll('.ref-panel')).toHaveLength(1);
});
