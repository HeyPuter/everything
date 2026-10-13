import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { onTab, downloadDocx } from './helpers/editor-tools.js';

async function newDocument(page, text) {
  await page.goto('/playground.html');
  await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('documents:')) localStorage.removeItem(key); });
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill(text);
  return input;
}
async function openFixture(page, name) {
  await page.goto('/playground.html');
  await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('documents:')) localStorage.removeItem(key); });
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.waitFor();
  page.once('dialog', dialog => dialog.accept());
  await page.getByLabel('Open DOCX file').setInputFiles(`tests/fixtures/review/${name}`);
  await expect(page.locator('.canvas-message')).not.toContainText('Opening');
  return input;
}
const select = (input, start, end = start) => input.evaluate((el, [a, b]) => { el.setSelectionRange(a, b); el.dispatchEvent(new Event('select', { bubbles: true })); }, [start, end]);
const review = page => page.locator('#ribbon-panel-review');
async function exported(page, info, name) {
  const download = page.waitForEvent('download');
  await downloadDocx(page);
  const path = info.outputPath(name);
  await (await download).saveAs(path);
  return { path, parts: unzipSync(readFileSync(path)) };
}

test('the Review tab holds proofing, accessibility, language, tracking, compare and protect groups', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await newDocument(page, 'Review tools sample text.');
  await onTab(page, 'review');
  for (const name of ['Editor', 'Thesaurus', 'Word Count', 'Check Accessibility', 'Translate', 'Language', 'New Comment', 'Track Changes', 'Show Markup', 'Tracking Options', 'Accept', 'Compare', 'Restrict Editing']) {
    await expect(review(page).getByRole('button', { name, exact: true, includeHidden: true }).first(), name).toBeAttached();
  }
  await page.screenshot({ path: info.outputPath('review-ribbon.png') });
  expect(errors).toEqual([]);
});
