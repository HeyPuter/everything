// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { closeMenu, openMenu } from '../src/ui/menu.js';

// A cell's dropdown list too long for the room under the cell, and for the room above it (a list of sixty
// options on a cell near the top of the sheet), was pushed up until it fitted whole: it covered the cell it
// belongs to and ran up over the menu bar and the ribbon. A menu too tall for either side of its anchor now
// opens on the side with more room, as tall as that room, and scrolls.
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1000);
  vi.stubGlobal('innerHeight', 600);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function () { return this.matches('.menu') ? 160 : 0; });
  // Sixty options of 26px: 1560px, whatever the cap.
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function () { return this.matches('.menu') ? 1560 : 0; });
});
afterEach(() => { closeMenu(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const items = Array.from({ length: 60 }, (_, i) => ({ label: `Option ${i + 1}` }));
const cell = (top) => ({ getBoundingClientRect: () => ({ left: 160, right: 224, top, bottom: top + 20, width: 64, height: 20 }), setAttribute() {} });

it('drops a long list below a cell near the top of the sheet and scrolls it there', () => {
  const { menu } = openMenu({ anchor: cell(231), items });
  expect(menu.style.top).toBe('255px'); // just under the cell, which stays in sight
  expect(menu.style.maxHeight).toBe('337px'); // to 8px above the window's bottom
  expect(menu.style.overflowY).toBe('auto');
});

it('opens a long list above a cell near the bottom, ending just over it', () => {
  const { menu } = openMenu({ anchor: cell(500), items });
  expect(menu.style.maxHeight).toBe('488px');
  expect(menu.style.top).toBe('8px');
  expect(parseFloat(menu.style.top) + parseFloat(menu.style.maxHeight)).toBe(496);
});
