import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { listAnnotations } from '../../src/core/annotations.js';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

test.skip(({ isMobile }) => isMobile, 'desktop workspace');

// Add with nothing typed placed an empty text box or callout: a frame with nothing to read.
test('a text box or callout needs words before it is added', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'empty-text.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);
  const sheet = await page.locator('.drawing-overlay').boundingBox();
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  for (const [tool, title] of [
    ['Add text comment', 'Text box'],
    ['Callout', 'Callout'],
  ]) {
    await pane.getByRole('button', { name: tool, exact: true }).click();
    await page.mouse.click(sheet.x + 60, sheet.y + 120);
    const dialog = page.getByRole('dialog', { name: title });
    const text = dialog.getByLabel('Text');
    await text.fill('   ');
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(dialog).toContainText(`Write something in the ${title.toLowerCase()}.`);
    await expect(text).toBeFocused();
    // Ctrl+Enter is refused the same way; words typed then go in.
    await text.press('ControlOrMeta+Enter');
    await expect(dialog).toBeVisible();
    await text.fill(`A ${title.toLowerCase()}`);
    await text.press('ControlOrMeta+Enter');
    await expect(dialog).toBeHidden();
    await settled(page);
  }
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = await PDFDocument.load(await readFile(await (await pending).path()));
  expect(listAnnotations(saved, 0).map((entry) => entry.contents)).toEqual([
    'A text box',
    'A callout',
  ]);
});
