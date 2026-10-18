// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openFieldDialog } from '../src/views/insert-dialogs.js';
import { closeAllModals } from '../src/ui/modal.js';

beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} })); });
afterEach(() => { closeAllModals(); vi.runAllTimers(); vi.useRealTimers(); document.body.replaceChildren(); vi.unstubAllGlobals(); });

const choose = (name, value) => { const control = document.querySelector(`[aria-label="${name}"]`); control.value = value; control.dispatchEvent(new Event('change')); return control; };
const formats = () => [...document.querySelector('select[aria-label="Format"]').options].map(o => o.value);

it('offers page fields only the number formats a page number can show', () => {
  openFieldDialog({ context: { now: new Date(2026, 0, 1) }, bookmarks: ['Greeting'], onInsert: vi.fn(() => true) });
  choose('Field names', 'NUMWORDS');
  expect(formats()).toContain('Ordinal');
  choose('Format', 'roman');
  for (const name of ['PAGE', 'NUMPAGES']) {
    choose('Field names', name);
    expect(formats()).toEqual(['', 'Arabic', 'roman', 'ROMAN', 'alphabetic', 'ALPHABETIC']);
    // A format both lists offer stays chosen.
    expect(document.querySelector('select[aria-label="Format"]').value).toBe('roman');
  }
  choose('Field names', 'SEQ');
  choose('Format', 'Ordinal');
  choose('Field names', 'PAGE');
  expect(document.querySelector('select[aria-label="Format"]').value).toBe('');
  expect(document.querySelector('.insert-field-code').textContent).toBe('{ PAGE \\* MERGEFORMAT }');
});
