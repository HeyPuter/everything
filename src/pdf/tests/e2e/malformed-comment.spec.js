import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName } from 'pdf-lib';
import { addShapeAnnotation } from '../../src/core/annotations.js';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

// A comment whose Rect cannot be read (some writers leave it out or write too many numbers)
// has nowhere to be on the page; it must not keep the page's other comments from opening.
for (const rect of [null, [0, 0, 10, 10, 5]])
  test(`a shape with ${rect ? 'a malformed' : 'no'} rectangle leaves the page and its other comments working`, async ({
    page,
  }) => {
    await page.route('https://js.puter.com/**', (route) => route.abort());
    const doc = await PDFDocument.create();
    doc.addPage([400, 500]);
    addShapeAnnotation(doc, 0, {
      kind: 'square',
      rect: { x: 20, y: 20, width: 40, height: 40 },
      text: 'Broken',
    });
    addShapeAnnotation(doc, 0, {
      kind: 'circle',
      rect: { x: 100, y: 200, width: 80, height: 60 },
      text: 'Fine',
    });
    const broken = doc.context.lookup(doc.getPage(0).node.Annots().get(0));
    if (rect) broken.set(PDFName.of('Rect'), doc.context.obj(rect));
    else broken.delete(PDFName.of('Rect'));
    await page.goto('/#library');
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: /^Open a PDF/ }).click();
    await (
      await chooser
    ).setFiles({
      name: 'malformed.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(await doc.save()),
    });
    await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
    await settled(page);
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    await page.getByRole('button', { name: 'Ellipse: Fine', exact: true }).click();
    const props = page.getByRole('complementary', { name: 'Selection properties' });
    await expect(props.getByLabel('Line width', { exact: true })).toBeVisible();
    await expect(page.locator('#toast')).toBeHidden();
  });
