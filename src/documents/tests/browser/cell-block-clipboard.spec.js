import { test, expect } from '@playwright/test';

const input = page => page.getByRole('textbox', { name: 'Document text' });
const engine = (page, fn, arg) => page.evaluate(([fn, arg]) => new Function('e', 'arg', `return (${fn})(e, arg)`)(window.__docs.current.view.engine, arg), [fn.toString(), arg]);
const cells = page => engine(page, e => e.model.paragraphs.filter(p => p.cellId).map(p => p.runs.map(r => r.text).join('')));
const clipboard = (page, kind) => input(page).evaluate((el, kind) => {
  const data = new DataTransfer();
  el.dispatchEvent(new ClipboardEvent(kind, { clipboardData: data, bubbles: true, cancelable: true }));
  return data.getData('text/plain');
}, kind);
/** The client point of a document position, for the mouse. */
const point = (page, position) => engine(page, (e, position) => {
  const g = e.positionGeometry(position), host = e.host.getBoundingClientRect();
  return { x: host.left - e.host.scrollLeft + g.left + 1, y: host.top - e.host.scrollTop + g.top + g.height / 2 };
}, position);

const GRID = ['A1', 'B1', 'C1', 'A2', 'B2', 'C2', 'A3', 'B3', 'C3'];
async function grid(page) {
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.locator('canvas.canvas-page').first().click({ position: { x: 150, y: 110 } });
  await engine(page, e => { e.insertTable(3, 3); e.focus(); });
  for (const [i, text] of GRID.entries()) { if (i) await input(page).press('Tab'); await page.keyboard.insertText(text); }
  expect(await cells(page)).toEqual(GRID);
}
/** Drag from A1 to B2, which highlights the two-by-two block; C1 lies between them in reading order but is not in it. */
async function dragBlock(page) {
  const value = await input(page).inputValue();
  const from = await point(page, value.indexOf('A1')), to = await point(page, value.indexOf('B2') + 2);
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2); await page.mouse.move(to.x, to.y); await page.mouse.up();
  expect(await engine(page, e => e.model.activeCellBlock && [e.model.cellBlock.top, e.model.cellBlock.bottom, e.model.cellBlock.left, e.model.cellBlock.right])).toEqual([0, 1, 0, 2]);
}

test('copy and cut of a block of table cells take only the cells it highlights', async ({ page }) => {
  await grid(page);
  await dragBlock(page);
  expect(await clipboard(page, 'copy')).toBe('A1\tB1\nA2\tB2');
  expect(await clipboard(page, 'cut')).toBe('A1\tB1\nA2\tB2');
  expect(await cells(page)).toEqual(['', '', 'C1', '', '', 'C2', 'A3', 'B3', 'C3']);
  await input(page).press('ControlOrMeta+z');
  expect(await cells(page)).toEqual(['A1', 'B1', 'C1', 'A2', 'B2', 'C2', 'A3', 'B3', 'C3']);

  // A selected column, whose text selection is only its first cell, copies every cell in it.
  await engine(page, e => { e.model.setCellBlock({ tableId: e.model.tables[0].id, top: 0, bottom: 2, left: 1, right: 2 }); e.syncInput(); e.paint(); });
  expect(await clipboard(page, 'copy')).toBe('B1\nB2\nB3');
});

test('Enter, Shift+Enter and Clear Contents over a block of table cells leave the cells outside it alone', async ({ page }) => {
  await grid(page);
  // A break replaces the first cell's text, as typing does.
  await dragBlock(page);
  await input(page).press('Enter');
  expect(await cells(page)).toEqual(['', '', ...GRID.slice(1)]);
  await input(page).press('ControlOrMeta+z');
  expect(await cells(page)).toEqual(GRID);
  await dragBlock(page);
  await input(page).press('Shift+Enter');
  expect(await cells(page)).toEqual(['\v', ...GRID.slice(1)]);
  await input(page).press('ControlOrMeta+z');
  // Clear Contents empties the block's own cells, as Delete does.
  await dragBlock(page);
  await page.evaluate(() => window.__docs.current.view.commands.clearContents());
  expect(await cells(page)).toEqual(['', '', 'C1', '', '', 'C2', 'A3', 'B3', 'C3']);
});

test('deleting a word or a line over a block of table cells empties only the cells in it', async ({ page }) => {
  await grid(page);
  const word = process.platform === 'darwin' ? 'Alt' : 'Control', line = process.platform === 'darwin' ? ['Meta+Backspace'] : [];
  for (const chord of [`${word}+Backspace`, `${word}+Delete`, ...line]) {
    await dragBlock(page);
    await input(page).press(chord);
    expect(await cells(page), chord).toEqual(['', '', 'C1', '', '', 'C2', 'A3', 'B3', 'C3']);
    await input(page).press('ControlOrMeta+z');
    expect(await cells(page)).toEqual(GRID);
  }
});
