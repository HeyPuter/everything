import { test, expect } from '@playwright/test';
import { PDFDocument, PDFString } from 'pdf-lib';
import { addShapeAnnotation } from '../../src/core/annotations.js';
import { addNote } from '../../src/core/notes.js';
import { addHighlight, rectQuad } from '../../src/core/highlight.js';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

// A cropped page keeps the comments and links outside its crop, which readers do not show.
// Their invisible targets ran on past the page and gave the workspace room to scroll into.
test('comments and links outside a cropped page leave the workspace without scrolling', async ({
  page,
}) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  const pdfPage = doc.addPage([612, 792]);
  addShapeAnnotation(doc, 0, {
    kind: 'square',
    rect: { x: 400, y: 600, width: 150, height: 150 },
    text: 'Outside',
  });
  addShapeAnnotation(doc, 0, {
    kind: 'square',
    rect: { x: 100, y: 100, width: 50, height: 50 },
    text: 'Inside',
  });
  addNote(doc, 0, { x: 560, y: 760, text: 'Note outside' });
  addHighlight(doc, 0, { quads: [rectQuad({ x: 420, y: 500, width: 150, height: 20 })] });
  pdfPage.node.addAnnot(
    doc.context.register(
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [420, 400, 600, 430],
        A: { S: 'URI', URI: PDFString.of('https://example.com/') },
      }),
    ),
  );
  pdfPage.setCropBox(50, 50, 300, 300);
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'crop.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Rectangle: Inside' })).toBeVisible();
  const overflow = await page
    .locator('.workspace')
    .evaluate((node) => [
      node.scrollWidth - node.clientWidth,
      node.scrollHeight - node.clientHeight,
    ]);
  expect(overflow[0]).toBeLessThanOrEqual(0);
  expect(overflow[1]).toBeLessThanOrEqual(0);
  // The comment on the page is still selected with a click.
  await page.getByRole('button', { name: 'Rectangle: Inside' }).click();
  await expect(
    page.getByRole('complementary', { name: 'Selection properties' }).getByLabel('Line width'),
  ).toBeVisible();
});
