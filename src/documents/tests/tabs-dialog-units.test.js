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
