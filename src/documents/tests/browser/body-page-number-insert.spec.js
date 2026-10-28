import { test, expect } from '@playwright/test';
import { onTab } from './helpers/editor-tools.js';

// A PAGE field inserted in the body shows the page's number as the page shows it: its format switch
// (\* roman) and the section's numbering (start and format) apply.
async function open(page) {
  // Wide enough that the Insert tab's Text group shows Quick Parts with any system font.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html');
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(input).toBeVisible();
  // Its first section is numbered ii, iii, … (lowerRoman from 2).
  await page.getByLabel('Open DOCX file').setInputFiles('public/fixtures/section-page-numbers-offset.docx');
  await expect(input).toHaveValue(/^Roman start, page 1/);
  await expect(input).toHaveJSProperty('readOnly', false);
  await page.evaluate(() => { const e = window.__docs.current.view.engine; e.model.select(e.model.paragraphs[0].runs.reduce((n, r) => n + r.text.length, 0)); e.focus(); });
  return input;
}
const firstParagraph = page => page.evaluate(() => window.__docs.current.view.engine.session.body.text.split('\n')[0]);

test('the Field dialog inserts PAGE with its format switch applied', async ({ page }) => {
  await open(page);
  const before = await firstParagraph(page);
  await onTab(page, 'insert');
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Quick Parts', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Field…' }).click();
  const field = page.getByRole('dialog', { name: 'Field' });
  await field.getByRole('listbox', { name: 'Field names' }).selectOption('PAGE');
  await field.getByRole('combobox', { name: 'Format' }).selectOption('ROMAN');
  await expect(field.locator('.insert-field-result')).toHaveText('II');
  await field.getByRole('button', { name: 'Insert' }).click();
  await expect.poll(() => firstParagraph(page)).toBe(`${before}II`);
});

test('Page Number > Current Position in the body shows the section\'s numbering', async ({ page }) => {
  await open(page);
  const before = await firstParagraph(page);
  await onTab(page, 'insert');
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Page Number', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Current Position', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Plain Number', exact: true }).click();
  await expect.poll(() => firstParagraph(page)).toBe(`${before}ii`);
  // Update Fields leaves body page numbers as they are (their result is the page they were inserted on).
  await page.keyboard.press('F9');
  await page.waitForTimeout(300);
  expect(await firstParagraph(page)).toBe(`${before}ii`);
});
