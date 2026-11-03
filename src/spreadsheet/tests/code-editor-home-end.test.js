// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createCodeEditor } from '../src/ui/code-editor.js';

// Home and End in the Code Editor go to the start and end of the caret's line. On a Mac the browser's own End
// scrolls to the bottom of the text and leaves the caret where it was: in a 3,000-line script, End with the caret
// on line 1,689 showed the script's last lines, some 25,000px from the caret.
vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
vi.stubGlobal('cancelAnimationFrame', clearTimeout);
afterEach(() => { document.body.replaceChildren(); delete HTMLTextAreaElement.prototype.clientHeight; delete HTMLTextAreaElement.prototype.clientWidth; });

const lines = Array.from({ length: 3000 }, (_, i) => `  const v${i} = sheet.getRange("A${i + 1}").getValue(); // line ${i + 1} with some trailing text`);
function setup() {
  Object.defineProperty(HTMLTextAreaElement.prototype, 'clientHeight', { configurable: true, get: () => 360 });
  Object.defineProperty(HTMLTextAreaElement.prototype, 'clientWidth', { configurable: true, get: () => 400 });
  const editor = createCodeEditor({ value: lines.join('\n') });
  document.body.append(editor.el);
  const { textarea } = editor;
  textarea.focus();
  const start = lines.slice(0, 1688).join('\n').length + 1; // line 1,689, from its start
  textarea.setSelectionRange(start + 10, start + 10);
  textarea.scrollTop = 1680 * 18;
  return { editor, textarea, start, end: start + lines[1688].length };
}
const press = (textarea, key, opts = {}) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts });
  textarea.dispatchEvent(event);
  return event;
};

it('moves the caret to the end of its line with End, keeping it in view', () => {
  const { editor, textarea, end } = setup();
  expect(press(textarea, 'End').defaultPrevented).toBe(true);
  expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([end, end]);
  expect(textarea.scrollTop).toBe(1680 * 18);
  // The line's end, past the right edge, is scrolled into view.
  expect(textarea.scrollLeft).toBeGreaterThan(0);
  expect(press(textarea, 'Home').defaultPrevented).toBe(true);
  expect(textarea.scrollLeft).toBe(0);
  editor.destroy();
});

it('moves to the start of the line with Home, and extends the selection with Shift', () => {
  const { editor, textarea, start, end } = setup();
  press(textarea, 'Home');
  expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([start, start]);
  press(textarea, 'End', { shiftKey: true });
  expect([textarea.selectionStart, textarea.selectionEnd, textarea.selectionDirection]).toEqual([start, end, 'forward']);
  textarea.setSelectionRange(start + 10, start + 10);
  press(textarea, 'Home', { shiftKey: true });
  expect([textarea.selectionStart, textarea.selectionEnd, textarea.selectionDirection]).toEqual([start, start + 10, 'backward']);
  press(textarea, 'End', { shiftKey: true });
  expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([start + 10, end]);
  editor.destroy();
});

it('brings a caret scrolled out of view back with End, and leaves Ctrl+End to the browser', () => {
  const { editor, textarea, end } = setup();
  textarea.scrollTop = 0;
  press(textarea, 'End');
  expect(textarea.selectionStart).toBe(end);
  expect(textarea.scrollTop).toBeLessThanOrEqual(1688 * 18);
  expect(textarea.scrollTop + 360).toBeGreaterThanOrEqual(1689 * 18);
  expect(press(textarea, 'End', { ctrlKey: true }).defaultPrevented).toBe(false);
  expect(press(textarea, 'Home', { metaKey: true }).defaultPrevented).toBe(false);
  editor.destroy();
});
