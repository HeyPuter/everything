import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';

// Every link to a place in the PDF was named "Link to another page": a screen reader going
// through a table of contents heard the same words for every entry, and not where any led.
test('a link is named after the page it leads to', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  for (let i = 0; i < 4; i++) doc.addPage([400, 500]);
  doc.catalog.set(PDFName.of('Dests'), doc.context.obj({ second: [doc.getPage(1).ref, 'Fit'] }));
  const links = [
    { Dest: [doc.getPage(2).ref, 'XYZ', 0, 400, null] },
    { Dest: PDFString.of('second') },
    { A: { S: 'Named', N: 'NextPage' } },
    { A: { S: 'Named', N: 'LastPage' } },
    { Dest: PDFString.of('nowhere') },
  ];
  links.forEach((target, i) =>
    doc.getPage(0).node.addAnnot(
      doc.context.register(
        doc.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [40, 440 - i * 60, 200, 460 - i * 60],
          ...target,
        }),
      ),
    ),
  );
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'links.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 4');
  const targets = page.locator('.link-target');
  await expect(targets).toHaveCount(5);
  await expect(targets.nth(0)).toHaveAccessibleName('Link to page 3');
  await expect(targets.nth(1)).toHaveAccessibleName('Link to page 2');
  await expect(targets.nth(2)).toHaveAccessibleName('Link to the next page');
  await expect(targets.nth(3)).toHaveAccessibleName('Link to the last page');
  // A destination the PDF does not have leads to no page it can name.
  await expect(targets.nth(4)).toHaveAccessibleName('Link to another page');
});
