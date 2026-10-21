// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { createSheetTabs } from '../src/ui/sheettabs.js';
import { closeMenu } from '../src/ui/menu.js';

globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

// A very hidden sheet (a file's setting, which Excel lists nowhere) stayed out of the tab menu's Unhide list but
// showed under "Hidden" in the All sheets menu, one click from being shown, and shown it kept its very hidden
// mark, so Move Chart, email and scripts went on leaving it out. The All sheets menu now lists only sheets a user hid.
let tabs;
beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { closeMenu(); tabs?.destroy(); document.body.replaceChildren(); });

it('lists the sheets a user hid, not the very hidden ones', () => {
  const wb = new Workbook({ sheets: [{ name: 'Summary' }, { name: 'Notes', hidden: true }, { name: 'Config', hidden: true, veryHidden: true }] });
  tabs = createSheetTabs({ wb });
  document.body.append(tabs.el);
  tabs.el.querySelector('[aria-label="All sheets"]').click();
  const labels = [...document.querySelectorAll('.menu [role^="menuitem"]')].map((item) => item.textContent.trim());
  expect(labels).toContain('Summary');
  expect(labels).toContain('Notes');
  expect(labels.some((label) => label.includes('Config'))).toBe(false);
});
