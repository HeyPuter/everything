// @vitest-environment jsdom
import { afterEach, it, expect, vi } from 'vitest';
import { paragraph } from '../src/engine/model.js';
import { CanvasEditor } from '../src/engine/canvas-editor.js';
import { DEFAULT_PAGE_SETTINGS } from '../src/engine/page-settings.js';
import { goToTargets, openGoTo } from '../src/views/go-to.js';
import { closeAllModals } from '../src/ui/modal.js';

afterEach(() => { closeAllModals(); vi.restoreAllMocks(); document.body.replaceChildren(); });

function editorWith(paragraphs, pageSettings) {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} }));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(new Proxy({
    fontKerning: 'auto', getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), measureText: text => ({ width: [...text].length * 8 }),
  }, { get: (t, k) => k in t ? t[k] : (typeof k === 'string' ? () => {} : undefined), set: (t, k, v) => { t[k] = v; return true; } }));
  const host = document.createElement('div'); document.body.append(host);
  return new CanvasEditor(host, { paragraphs, pageSettings });
}

// Go To > Page > Next went from page 1 straight to page 3 when page 2 had no body text (the blank page before an
// odd-page section): the step went by text position, which the blank page shares with the text before it.
it('steps through pages without body text with Next and Previous', () => {
  const first = paragraph('First section', { sectionEnd: { ...DEFAULT_PAGE_SETTINGS } });
  const editor = editorWith([first, paragraph('Second section'), paragraph('More')], { ...DEFAULT_PAGE_SETTINGS, sectionType: 'oddPage' });
  expect(editor.layout.pageCount).toBe(3);
  const pages = goToTargets(editor, 'page');
  // The blank page goes to where the text before it ends.
  expect(pages.map(p => [p.position, !!p.empty])).toEqual([[0, false], ['First section'.length, true], ['First section\n'.length, false]]);
  editor.model.select(0);
  openGoTo(editor);
  const next = [...document.querySelectorAll('button')].find(b => b.textContent === 'Next');
  const previous = [...document.querySelectorAll('button')].find(b => b.textContent === 'Previous');
  const visited = [];
  for (let i = 0; i < 2; i++) { next.click(); visited.push(editor.model.range[0]); }
  expect(visited).toEqual([pages[1].position, pages[2].position]);
  previous.click(); expect(editor.model.range[0]).toBe(pages[1].position);
  previous.click(); expect(editor.model.range[0]).toBe(0);
  // Relative steps count from the page gone to.
  next.click();
  const number = document.querySelector('input[type="text"]');
  number.value = '+1'; number.dispatchEvent(new Event('input'));
  document.querySelector('form').requestSubmit();
  expect(editor.model.range[0]).toBe(pages[2].position);
  editor.destroy();
});
