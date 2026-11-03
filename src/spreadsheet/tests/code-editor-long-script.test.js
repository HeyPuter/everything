// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createCodeEditor } from '../src/ui/code-editor.js';

// The Code Editor draws its text in a layer under the textarea, coloured, and a second layer for the marks (search
// matches, the bracket pair at the caret). Both were drawn whole, every line of the script, at each key typed and at
// each move of the caret: in a script of 5,000 lines a key took 200-380 ms to show and an arrow key 25-90 ms. They now
// draw the lines in view and a margin around them, placed where those lines sit.
vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
vi.stubGlobal('cancelAnimationFrame', clearTimeout);
afterEach(() => { document.body.replaceChildren(); delete HTMLTextAreaElement.prototype.clientHeight; });

const script = (n) => ['async function main(workbook) {', ...Array.from({ length: n }, (_, i) => `  const v${i} = (${i}); // line ${i + 2}`), '}'].join('\n');

it('draws the lines in view of a long script, and follows the scrolling', async () => {
  // The editor shows twenty lines.
  Object.defineProperty(HTMLTextAreaElement.prototype, 'clientHeight', { configurable: true, get: () => 360 });
  const editor = createCodeEditor({ value: script(2000) });
  document.body.append(editor.el);
  const { textarea } = editor;
  const code = editor.el.querySelector('.ce-code'), marks = editor.el.querySelector('.ce-marks');
  expect(code.textContent.split('\n').length).toBeLessThan(400);
  textarea.scrollTop = 1500 * 18;
  textarea.dispatchEvent(new Event('scroll'));
  const lines = code.textContent.split('\n');
  expect(lines.length).toBeLessThan(400);
  const first = Number(/line (\d+)/.exec(lines[0])[1]) - 1; // the script line the layer starts at, from 0
  expect(code.style.top).toBe(`${first * 18}px`);
  expect(code.textContent).toContain('// line 1501');
  expect(code.querySelector('.ce-comment')).not.toBeNull();
  // The caret beside a bracket marks its pair, on the lines drawn, without the rest of the script.
  const at = textarea.value.indexOf('(1500)');
  textarea.focus();
  textarea.setSelectionRange(at, at);
  document.dispatchEvent(new Event('selectionchange'));
  expect(marks.querySelectorAll('mark.ce-bracket-match')).toHaveLength(2);
  expect(marks.textContent.length).toBeLessThan(code.textContent.length);
  expect(marks.style.top).toBe(code.style.top);
  // Typing redraws the lines in view with the new text.
  textarea.setRangeText('Z', at + 1, at + 1);
  textarea.dispatchEvent(new Event('input'));
  await new Promise((r) => setTimeout(r, 5));
  expect(code.textContent).toContain('(Z1500)');
  expect(code.textContent.split('\n').length).toBeLessThan(400);
  editor.destroy();
});

it('draws every line where nothing is laid out', () => {
  const editor = createCodeEditor({ value: script(500) });
  document.body.append(editor.el);
  expect(editor.el.querySelector('.ce-code').textContent.split('\n').length).toBe(503);
  editor.destroy();
});
