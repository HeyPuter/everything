// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createLanguagePane } from '../src/ui/language-pane.js';
import { Workbook } from '../src/core/workbook.js';

// Review ▸ Translate: Ctrl/Cmd+Enter in the text box translates as the Translate button does, but went on working
// while a translation was under way, when the button is disabled. The first answer to come back then enabled Insert
// with its text, a later one replaced it, and which one Insert put into the sheet depended on timing.
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

it('starts no second translation while one is under way', async () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const pending = [];
  const translate = vi.fn((text) => new Promise((resolve) => pending.push(() => resolve(`${text}!`))));
  const pane = createLanguagePane({ wb, sheetId: () => id, active: () => ({ r: 0, c: 0 }), ranges: () => [{ r1: 0, c1: 0, r2: 0, c2: 0 }], activeCell: () => null, grid: { focus() {} }, announce() {}, translate });
  document.body.append(pane.el);
  pane.show('translate');
  const source = pane.el.querySelector('.lang-source');
  source.value = 'hello';
  pane.translateNow();
  source.value = 'goodbye';
  source.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
  expect(translate).toHaveBeenCalledTimes(1);
  pending.forEach((answer) => answer());
  await new Promise((r) => setTimeout(r, 0));
  expect(pane.el.querySelector('.lang-output').textContent).toBe('hello!');
  // Once it has answered, the next one goes.
  pane.translateNow();
  expect(translate).toHaveBeenCalledTimes(2);
});
