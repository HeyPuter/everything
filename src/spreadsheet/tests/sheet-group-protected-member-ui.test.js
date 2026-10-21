// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { closeMenu } from '../src/ui/menu.js';
import { closeAllModals } from '../src/ui/modal.js';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import * as notifications from '../src/ui/toast.js';

// A protected sheet in a group now refuses the group's Insert rows, Merge or Hide (see
// sheet-group-protected-member.test.js), and says so for itself. The editor read the refusal as one of its own
// kind on the sheet in view and added its own explanation on top: "The row cannot be inserted here: cells would be
// pushed off the sheet", "The header and data cells of a table cannot be merged", "Every row cannot be hidden".
function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() };
}
let view;
beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { closeMenu(); closeAllModals(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

it('names only the protected sheet when it refuses an edit to the group', async () => {
  const doc = new Doc({ name: 'Budget', path: 'Spreadsheets/Budget.xlsx' });
  const wb = doc.wb;
  const [a, b] = [wb.activeSheetId, wb.addSheet('Feb').id];
  wb.setActiveSheet(a);
  wb.setSheetProtected(b, true);
  wb.clearHistory();
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  wb.groupSheets([b]);
  const toast = vi.spyOn(notifications, 'toast');
  for (const [cmd, arg] of [['insertRows', 'above'], ['merge', null], ['hide', 'row']]) {
    toast.mockClear();
    await vi.advanceTimersByTimeAsync(3000); // past the pause that folds repeated protection notices into one
    view.goTo(cmd === 'merge' ? 'Sheet1!A1:B1' : 'Sheet1!A1');
    await view.run(cmd, arg);
    const said = toast.mock.calls.map(([text]) => text);
    expect(said, cmd).toEqual(['Feb is protected. Unprotect it from the sheet tab menu to make changes']);
  }
  expect(wb.canUndo()).toBe(false);
});
