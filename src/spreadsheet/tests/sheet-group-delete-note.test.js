// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import * as notifications from '../src/ui/toast.js';
import { menubarMenus, menuLeaves } from '../src/ui/menubar.js';
import { paletteCommands } from '../src/ui/palette.js';
import { GROUP_BLOCKED_REASON } from '../src/core/sheet-group.js';

// With sheets grouped, New Note was refused (a note belongs to one sheet's cell) while Delete Note still went ahead
// on the active sheet alone, leaving the notes at that cell on the other grouped sheets. As in Excel, where the
// notes commands wait while sheets are grouped, Delete Note is now refused with the same reason.
let view;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

async function mount() {
  const doc = new Doc({ name: 'Notes' });
  const wb = doc.wb;
  wb.addSheet('Feb');
  wb.setActiveSheet(wb.sheets[0].id);
  const [a, b] = wb.sheets.map((s) => s.id);
  wb.setNote(a, 0, 0, 'January note');
  wb.setNote(b, 0, 0, 'February note');
  wb.clearHistory();
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  return { wb, a, b };
}

it('refuses Delete Note while sheets are grouped, as New Note is', async () => {
  const { wb, a, b } = await mount();
  const toast = vi.spyOn(notifications, 'toast');
  wb.groupSheets([a, b]);
  await view.run('deleteNote');
  expect(toast).toHaveBeenCalledWith(GROUP_BLOCKED_REASON, expect.anything());
  expect(wb.getNote(a, 0, 0)).toBe('January note');
  expect(wb.getNote(b, 0, 0)).toBe('February note');
  expect(wb.undoLabels()).toEqual([]);
});

it('greys Delete Note in the menus while sheets are grouped', () => {
  const leaves = menubarMenus({ grouped: true, hasNote: true }).flatMap((m) => menuLeaves(m.items));
  const item = leaves.find((l) => l.cmd === 'deleteNote');
  expect(item?.disabled).toBe(true);
  expect(paletteCommands({ grouped: true, hasNote: true }).some((c) => c.cmd === 'deleteNote')).toBe(false);
});

it('still deletes the note when the sheets are not grouped', async () => {
  const { wb, a, b } = await mount();
  await view.run('deleteNote');
  expect(wb.getNote(a, 0, 0)).toBeFalsy();
  expect(wb.getNote(b, 0, 0)).toBe('February note');
});
