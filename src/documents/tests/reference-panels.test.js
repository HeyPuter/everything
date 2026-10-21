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

it('hands the focus back to what opened a reference panel when it closes', () => {
  const opener = document.createElement('button');
  document.body.append(opener);
  opener.focus();
  const entry = openPanel({ title: 'Mark Index Entry', body: [document.createElement('input')] });
  expect(entry.node.contains(document.activeElement)).toBe(true);
  // Opening another panel from this one keeps the original opener for it.
  const citation = openPanel({ title: 'Mark Citation', body: [document.createElement('input')] });
  citation.node.querySelector('input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  expect(document.querySelector('.ref-panel')).toBeNull();
  expect(document.activeElement).toBe(opener);
  // A panel closed while the focus is elsewhere leaves it there.
  const other = document.createElement('input');
  document.body.append(other);
  const again = openPanel({ title: 'Mark Citation', body: [document.createElement('input')] });
  other.focus();
  again.node.querySelector('.ref-panel-close').click();
  expect(document.activeElement).toBe(other);
});
