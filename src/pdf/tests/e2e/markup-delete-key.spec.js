import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { addHighlight, listHighlights, rectQuad } from '../../src/core/highlight.js';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

test.skip(({ isMobile }) => isMobile, 'desktop workspace');

// The Delete key removed a selected text box, shape or drawing, but did nothing to a selected
// highlight, underline or strikethrough: only its Delete button did.
test('the Delete key deletes a selected or focused markup', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([400, 400]);
  sheet.drawText('First words', { x: 50, y: 300, size: 14 });
  sheet.drawText('Second words', { x: 50, y: 200, size: 14 });
  addHighlight(doc, 0, { quads: [rectQuad({ x: 48, y: 296, width: 90, height: 18 })], text: 'A' });
  addHighlight(doc, 0, {
    kind: 'strikeout',
    quads: [rectQuad({ x: 48, y: 196, width: 100, height: 18 })],
    text: 'B',
  });
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'markup-delete.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);
  await page.getByRole('button', { name: 'Select', exact: true }).click();

  // Chosen with the pointer, the highlight's settings take the keyboard; Delete removes it.
  await page.getByRole('button', { name: 'Edit highlight: A', exact: true }).click();
  await expect(page.getByLabel('Highlight color', { exact: true })).toBeFocused();
  await page.keyboard.press('Delete');
  await settled(page);
  await expect(page.getByRole('button', { name: 'Edit highlight: A', exact: true })).toHaveCount(0);
  // Focus stays on the page, as after the Delete button.
  await expect(page.locator('.drawing-overlay')).toBeFocused();

  // Reached with the keyboard, the markup itself takes Backspace.
  const strike = page.getByRole('button', { name: 'Edit strikethrough: B', exact: true });
  await strike.focus();
  await page.keyboard.press('Backspace');
  await settled(page);
  await expect(strike).toHaveCount(0);

  // One undo step each.
  await page.keyboard.press('ControlOrMeta+z');
  await settled(page);
  await expect(strike).toHaveCount(1);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = await PDFDocument.load(await readFile(await (await pending).path()));
  expect(listHighlights(saved, 0).map((h) => h.text)).toEqual(['B']);
});
