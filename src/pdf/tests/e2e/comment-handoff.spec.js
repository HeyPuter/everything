import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { addShapeAnnotation } from '../../src/core/annotations.js';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==',
  'base64',
);

// Choosing a comment is choosing another object: the picture or text being edited lets go,
// as it does when a highlight or note is chosen, instead of staying selected beside it.
test('choosing a comment finishes the text draft and lets go of a picture', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([400, 500]);
  sheet.drawText('Some words here', {
    x: 40,
    y: 450,
    size: 20,
    font: await doc.embedFont(StandardFonts.Helvetica),
  });
  sheet.drawImage(await doc.embedPng(PNG), { x: 40, y: 60, width: 100, height: 100 });
  addShapeAnnotation(doc, 0, { kind: 'square', rect: { x: 200, y: 250, width: 80, height: 60 } });
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'comment-handoff.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  const props = page.getByRole('complementary', { name: 'Selection properties' });
  const comment = page.getByRole('button', { name: 'Rectangle', exact: true });

  await page.getByRole('button', { name: 'Select image 1', exact: true }).click();
  await expect(props.getByRole('heading', { name: 'Image' })).toBeVisible();
  await comment.click();
  await expect(props.getByRole('heading', { name: 'Rectangle' })).toBeVisible();
  await expect(page.locator('.image-controls')).toBeHidden();
  await expect(comment).toHaveAttribute('aria-pressed', 'true');

  await page
    .getByRole('button', { name: /Some words here/ })
    .first()
    .dblclick();
  const input = page.getByRole('textbox', { name: 'Edit text', exact: true });
  await expect(input).toBeFocused();
  await input.evaluate((node) => node.setSelectionRange(node.value.length, node.value.length));
  await page.keyboard.insertText(' too');
  await comment.click();
  await expect(input).toHaveCount(0);
  await settled(page);
  await expect(props.getByRole('heading', { name: 'Rectangle' })).toBeVisible();
  await expect(comment).toHaveAttribute('aria-pressed', 'true');
  await expect(comment).toBeFocused();
  // And the other way round: a chosen picture lets go of the comment.
  await page.getByRole('button', { name: 'Select image 1', exact: true }).click();
  await expect(props.getByRole('heading', { name: 'Image' })).toBeVisible();
  await expect(comment).toHaveAttribute('aria-pressed', 'false');

  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const bytes = new Uint8Array(await readFile(await (await pending).path()));
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: bytes,
    standardFontDataUrl: new URL('../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)
      .pathname,
  });
  try {
    const content = await (await (await task.promise).getPage(1)).getTextContent();
    expect(content.items.map((item) => item.str).join('')).toContain('Some words here too');
  } finally {
    await task.destroy();
  }
});
