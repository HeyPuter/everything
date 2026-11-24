// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openTabsDialog } from '../src/views/tabs-dialog.js';
import { closeAllModals } from '../src/ui/modal.js';

beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} })); });
afterEach(() => { closeAllModals(); vi.runAllTimers(); vi.useRealTimers(); document.body.replaceChildren(); vi.unstubAllGlobals(); });

it.each([['in', '2.54 cm', 1440], ['in', '1.5', 2160], ['in', '36pt', 720], ['cm', '1 in', 1440], ['cm', '2,54', 1440], ['cm', '25.4mm', 1440]])('in a %s dialog, "%s" is %i twips', (unit, typed, twips) => {
  const apply = vi.fn(() => true);
  openTabsDialog({ tabs: [], defaultTabStop: 720, unit, apply });
  document.querySelector(`[aria-label^="Tab stop position"]`).value = typed;
  document.querySelector('form').requestSubmit();
  expect(apply.mock.calls[0][0][0].position).toBe(twips);
});

// A listed stop chosen and given another alignment or leader is changed by OK, as a new position typed there is set:
// without Set first, the change was lost.
it('applies a chosen stop\'s new alignment and leader on OK, and leaves untouched stops alone', () => {
  const apply = vi.fn(() => true);
  const tabs = [{ position: 1440, alignment: 'left' }, { position: 2880, alignment: 'center' }];
  openTabsDialog({ tabs, defaultTabStop: 720, unit: 'in', apply });
  // The first stop is chosen as the dialog opens; OK with nothing changed changes nothing.
  document.querySelector('form').requestSubmit();
  expect(apply).not.toHaveBeenCalled();
  closeAllModals(); vi.runAllTimers(); document.body.replaceChildren();
  openTabsDialog({ tabs, defaultTabStop: 720, unit: 'in', apply });
  [...document.querySelectorAll('[role="option"]')].at(-1).click();
  for (const value of ['right', 'dot']) document.querySelector(`input[type="radio"][value="${value}"]`).click();
  document.querySelector('form').requestSubmit();
  expect(apply.mock.calls[0][0]).toEqual([{ position: 1440, alignment: 'left' }, { position: 2880, alignment: 'right', leader: 'dot' }]);
});
