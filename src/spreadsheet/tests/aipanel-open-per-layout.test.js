// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { createAiPanel, loadAiSettings } from '../src/ui/aipanel.js';
import * as P from '../src/lib/puter.js';

let width = 1200;
const media = (query) => { const max = /max-width:\s*(\d+)px/.exec(query); return { matches: max ? width <= Number(max[1]) : false, addEventListener() {}, removeEventListener() {} }; };
beforeEach(() => {
  vi.stubGlobal('matchMedia', media);
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.spyOn(P, 'canAI').mockReturnValue(true);
  localStorage.clear();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); document.body.replaceChildren(); });

/** The app opening in a window `w` px wide: the panel as the editor makes it, opened when the settings say so. */
function openApp(w) {
  width = w;
  const wb = new Workbook();
  const ctx = { wb, doc: { name: 'Test' }, subscribe: () => () => {}, grid: { focus() {}, editing: false }, run() {} };
  const panel = createAiPanel(ctx, { sheetId: () => wb.activeSheetId, selection: () => null, select: () => true });
  document.body.append(panel.el);
  if (loadAiSettings().open) panel.open({ focus: false });
  return panel;
}

// The panel opened in a wide window (where it opens by itself) was remembered as open, and the next time the app
// opened at a phone's width it came up as a sheet over the whole grid, where a first visit shows the grid.
describe('the assistant\'s open or closed state', () => {
  it('left open in a wide window does not open over the grid on a phone', () => {
    const wide = openApp(1200);
    expect(wide.isOpen).toBe(true);
    wide.destroy();
    const phone = openApp(390);
    expect(phone.isOpen).toBe(false);
    phone.destroy();
    // The wide window keeps its choice.
    const again = openApp(1200);
    expect(again.isOpen).toBe(true);
    again.destroy();
  });

  it('keeps each layout\'s own choice: opened on a phone, closed in a wide window', () => {
    const phone = openApp(390);
    phone.open({ focus: false });
    phone.destroy();
    expect(openApp(390).isOpen).toBe(true);
    const wide = openApp(1200);
    wide.close({ focusGrid: false });
    wide.destroy();
    expect(openApp(1200).isOpen).toBe(false);
    expect(openApp(390).isOpen).toBe(true);
  });

  it('is not opened or closed by resizing a live window', () => {
    const panel = openApp(1200);
    width = 390;
    window.dispatchEvent(new Event('resize'));
    expect(panel.isOpen).toBe(true);
    width = 1200;
    window.dispatchEvent(new Event('resize'));
    expect(panel.isOpen).toBe(true);
  });
});
