// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { createLanguagePane } from '../src/ui/language-pane.js';

// The translator's Replace cells puts each translation into the cell its text came from, by the address the
// text was read at. A row inserted above, or a cell typed over, between Translate and Replace cells, and the
// translations landed on the wrong cells: A1 (now the new empty row) took Hello's translation and A2's Hello was
// overwritten with World's, losing it, and a cell retyped meanwhile lost what had been typed. Cells that no longer
// hold the text translated are now left as they are, with a word to translate them again.
afterEach(() => { document.querySelectorAll('.lang-pane').forEach((n) => n.remove()); });

async function translated() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setCells(id, [{ r: 0, c: 0, cell: { v: 'Hello' } }, { r: 1, c: 0, cell: { v: 'World' } }]);
  const pane = createLanguagePane({ wb, sheetId: () => id, ranges: () => [{ r1: 0, c1: 0, r2: 1, c2: 0 }],
    active: () => ({ r: 0, c: 0 }), activeCell: () => wb.getCell(id, 0, 0), grid: { focus() {} }, ai: null,
    translate: async (text) => `${text.toUpperCase()}!`, announce() {} });
  document.body.append(pane.el);
  pane.show('translate', { fromCell: true });
  await new Promise((r) => setTimeout(r, 0));
  const replace = [...pane.el.querySelectorAll('button')].find((b) => b.textContent === 'Replace cells');
  return { wb, id, replace };
}
const column = (wb, id) => [0, 1, 2].map((r) => wb.getCell(id, r, 0)?.v ?? null);

it('replaces the cells the text came from', async () => {
  const { wb, id, replace } = await translated();
  replace.click();
  expect(column(wb, id)).toEqual(['HELLO!', 'WORLD!', null]);
});

it('leaves the cells alone when rows inserted above have moved the text', async () => {
  const { wb, id, replace } = await translated();
  wb.insertRows(id, 0, 1);
  replace.click();
  expect(column(wb, id)).toEqual([null, 'Hello', 'World']);
  expect(document.querySelector('.toast-root').textContent).toMatch(/A1 has changed since it was translated; nothing was replaced/);
});

it('leaves a cell typed over since the translation alone', async () => {
  const { wb, id, replace } = await translated();
  wb.setInput(id, 1, 0, 'Typed since');
  replace.click();
  expect(column(wb, id)).toEqual(['Hello', 'Typed since', null]);
});
