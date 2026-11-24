// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openFormatPageNumbers } from '../src/views/insert-dialogs.js';
import { closeAllModals } from '../src/ui/modal.js';

beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} })); });
afterEach(() => { closeAllModals(); vi.runAllTimers(); vi.useRealTimers(); document.body.replaceChildren(); vi.unstubAllGlobals(); });

// A section numbered in a format the dialog does not list (note symbols, here) showed a blank Number format, and OK
// changed its pages to 1, 2, 3.
it('keeps a page number format it does not list, shown as its numbers', () => {
  const onApply = vi.fn(() => true);
  openFormatPageNumbers({ current: { format: 'chicago', start: 3 }, onApply });
  const format = document.querySelector('select[aria-label="Number format"]');
  expect(format.value).toBe('chicago');
  expect(format.selectedOptions[0].textContent).toBe('*, †, ‡, …');
  document.querySelector('form').requestSubmit();
  expect(onApply).toHaveBeenCalledWith({ format: 'chicago', start: 3 });
  // A listed format adds nothing.
  closeAllModals();
  openFormatPageNumbers({ current: { format: 'upperRoman' }, onApply });
  expect([...document.querySelectorAll('select[aria-label="Number format"]')].at(-1).options).toHaveLength(7);
});
