import { test, expect } from '@playwright/test';

// The offset fixture's sections restart and reformat their page numbers: its fifth sheet is numbered 8,
// its eleventh L, and 1 appears twice (sheets 8 and 26), the second time in a later section.
const FIXTURE = 'public/fixtures/section-page-numbers-offset.docx';
const sheet = page => page.evaluate(() => window.__docs.current.view.engine.caretPageIndex);

async function open(page) {
  await page.goto('/mock.html');
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(input).toBeVisible();
  await page.getByLabel('Open DOCX file').setInputFiles(FIXTURE);
  await expect(input).toHaveValue(/^Roman start, page 1/);
  await expect(input).toHaveJSProperty('readOnly', false);
  await page.evaluate(() => { const e = window.__docs.current.view.engine; e.model.select(0); e.focus(); });
}
async function goTo(page, value) {
  await page.getByRole('textbox', { name: 'Document text' }).press(process.platform === 'darwin' ? 'Meta+Alt+g' : 'Control+g');
  const dialog = page.getByRole('dialog', { name: 'Go To' });
  await dialog.getByRole('textbox', { name: 'Enter page number' }).fill(value);
  await dialog.getByRole('textbox', { name: 'Enter page number' }).press('Enter');
  await expect(dialog).toBeHidden();
}

test('Go To Page finds the page by the number printed on it, in a section that restarts numbering', async ({ page }) => {
  await open(page);
  await goTo(page, '8');
  expect(await sheet(page)).toBe(4);
  // A number shown in letters or Roman numerals is found as it is shown.
  await goTo(page, 'L');
  expect(await sheet(page)).toBe(10);
  // A number used again in a later section: the first, or the one in the section named with "s".
  await goTo(page, '1');
  expect(await sheet(page)).toBe(7);
  const section = await page.evaluate(() => window.__docs.current.view.engine.layout.pageSections[25] + 1);
  await goTo(page, `p1s${section}`);
  expect(await sheet(page)).toBe(25);
  // + and − still count pages from where the caret is.
  await goTo(page, '8');
  await goTo(page, '+2');
  expect(await sheet(page)).toBe(6);
});
