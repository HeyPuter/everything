// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import * as notifications from '../src/ui/toast.js';

// Ctrl+Enter over more than 50,000 cells (a whole column, say) and Ctrl+Shift+Enter over several ranges are refused,
// the entry kept open, but the reason went only to the screen reader's live region: on screen the keys seemed to do
// nothing. The reason is now shown as well.
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

async function mount() {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  const doc = new Doc({ name: 'Fill' });
  const view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  const said = vi.spyOn(notifications, 'toast');
  const type = (text) => {
    const viewport = view.el.querySelector('.grid-viewport');
    viewport.focus();
    viewport.dispatchEvent(new KeyboardEvent('keydown', { key: text[0], bubbles: true, cancelable: true }));
    const editor = view.el.querySelector('.grid-editor');
    editor.value = text;
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text.at(-1) }));
    return editor;
  };
  return { wb: doc.wb, view, said, type };
}

it('shows why Ctrl+Enter over a whole column is refused', async () => {
  const { wb, view, said, type } = await mount();
  view.goTo('Sheet1!C:C');
  const editor = type('x');
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, metaKey: true, bubbles: true, cancelable: true }));
  expect(said.mock.calls.map(([m]) => m)).toContain('Select at most 50,000 cells to fill at once');
  expect(editor.hidden).toBe(false);
  expect(wb.getValue(wb.activeSheetId, 0, 2)).toBe(null);
  view.destroy();
});
