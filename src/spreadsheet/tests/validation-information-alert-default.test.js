// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { confirmValidation } from '../src/ui/validation-alert.js';
import { closeAllModals } from '../src/ui/modal.js';

beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('matchMedia', () => ({ matches: true })); document.body.innerHTML = '<div id="app"></div>'; });
afterEach(() => { closeAllModals(); vi.runAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

// An Information alert opened on its Cancel button, so Enter (pressed again after the entry, as one does to
// dismiss a notice) threw the typed value away. Excel's Information alert starts on OK, which keeps the entry;
// a Stop alert still starts on Retry, and a Warning keeps its focus where it was.
it('starts an Information alert on OK', async () => {
  const answer = confirmValidation({ message: 'Prices are usually under 100.', rule: { strict: false, errorStyle: 'information' } });
  expect(document.activeElement.textContent).toBe('OK');
  document.activeElement.click();
  await expect(answer).resolves.toBe('accept');
});

it('starts a Stop alert on Retry', async () => {
  const answer = confirmValidation({ message: 'No.', rule: { strict: true } });
  expect(document.activeElement.textContent).toBe('Retry');
  document.activeElement.click();
  await expect(answer).resolves.toBe('retry');
});
