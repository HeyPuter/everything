import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { addShapeAnnotation, listAnnotations } from '../../src/core/annotations.js';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

test.skip(({ isMobile }) => isMobile, 'desktop workspace');

// Escape let go of a selected highlight or note from its settings, but in a shape's or text
// box's settings it did nothing: the comment stayed selected with the keyboard in its panel.
test('Escape in a comment’s settings lets go of it and keeps the words typed', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  addShapeAnnotation(doc, 0, { kind: 'square', rect: { x: 100, y: 100, width: 80, height: 60 } });
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'panel-escape.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  const props = page.getByRole('complementary', { name: 'Selection properties' });
  await page.getByRole('button', { name: 'Rectangle', exact: true }).click();
  const text = props.getByLabel('Comment', { exact: true });
  await text.click();
  await page.keyboard.type('Typed then left');
  await page.keyboard.press('Escape');
  await settled(page);
  await expect(text).toHaveCount(0);
  await expect(page.locator('.drawing-overlay')).toBeFocused();
  const target = page.getByRole('button', { name: /^Rectangle/ });
  await expect(target).toHaveAttribute('aria-pressed', 'false');
  // From a setting other than the text too.
  await target.click();
  await props.getByLabel('Opacity', { exact: true }).focus();
  await page.keyboard.press('Escape');
  await expect(props.getByLabel('Opacity', { exact: true })).toHaveCount(0);
  await expect(page.locator('.drawing-overlay')).toBeFocused();

  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = await PDFDocument.load(await readFile(await (await pending).path()));
  expect(listAnnotations(saved, 0)[0].contents).toBe('Typed then left');
});
