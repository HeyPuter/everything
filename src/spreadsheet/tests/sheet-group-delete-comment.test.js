// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import * as notifications from '../src/ui/toast.js';
import { menubarMenus, menuLeaves } from '../src/ui/menubar.js';
import { paletteCommands } from '../src/ui/palette.js';
import { addComment, getThread } from '../src/core/comments.js';
import { GROUP_BLOCKED_REASON } from '../src/core/sheet-group.js';

// With sheets grouped, New Comment was refused (a comment belongs to one sheet's cell) while Delete Comment still went
// ahead on the active sheet alone, leaving the comments at that cell on the other grouped sheets; the ribbon's
// Comments buttons were not greyed for a group at all. As in Excel, where the comment commands wait while sheets are
// grouped, Delete Comment is now refused with the same reason, and both ribbon buttons are greyed.
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
  const doc = new Doc({ name: 'Comments' });
  const wb = doc.wb;
  wb.addSheet('Feb');
  wb.setActiveSheet(wb.sheets[0].id);
  const [a, b] = wb.sheets.map((s) => s.id);
  addComment(wb, a, 0, 0, 'January comment', 'Ann');
  addComment(wb, b, 0, 0, 'February comment', 'Ann');
  wb.clearHistory();
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  return { wb, a, b };
}

const ribbonButton = (label) => view.el.querySelector(`button[aria-label="${label}"]`);

it('refuses Delete Comment while sheets are grouped, as New Comment is', async () => {
  const { wb, a, b } = await mount();
  const toast = vi.spyOn(notifications, 'toast');
  wb.groupSheets([a, b]);
  await view.run('deleteComment');
  expect(toast).toHaveBeenCalledWith(GROUP_BLOCKED_REASON, expect.anything());
  expect(getThread(wb, a, 0, 0)).toBeTruthy();
  expect(getThread(wb, b, 0, 0)).toBeTruthy();
  expect(wb.undoLabels()).toEqual([]);
});

it('greys Delete Comment and New Comment while sheets are grouped', async () => {
  const { wb, a, b } = await mount();
  expect(ribbonButton('Delete Comment').disabled).toBe(false);
  wb.groupSheets([a, b]);
  await vi.advanceTimersByTimeAsync(50);
  expect(ribbonButton('Delete Comment').disabled).toBe(true);
  expect(ribbonButton('New Comment').disabled).toBe(true);
  const item = menubarMenus({ grouped: true, hasComment: true }).flatMap((m) => menuLeaves(m.items)).find((l) => l.cmd === 'deleteComment');
  expect(item?.disabled).toBe(true);
  expect(paletteCommands({ grouped: true, hasComment: true, hasComments: true }).some((c) => c.cmd === 'deleteComment')).toBe(false);
});

it('still deletes the comment when the sheets are not grouped', async () => {
  const { wb, a, b } = await mount();
  await view.run('deleteComment');
  expect(getThread(wb, a, 0, 0)).toBeFalsy();
  expect(getThread(wb, b, 0, 0)).toBeTruthy();
});
