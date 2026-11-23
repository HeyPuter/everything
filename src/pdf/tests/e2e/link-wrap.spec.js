import { test, expect } from '@playwright/test';
import { PDFDocument, PDFString } from 'pdf-lib';

// A link over words that wrap onto the next line has a box for each line (QuadPoints) inside
// a rectangle that spans both lines. Only those boxes are the link: the rest of the rectangle
// holds other words, and here another link, which must still be reached.
test('a link over wrapped words takes the pointer only over its words', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  const first = doc.addPage([400, 500]);
  const link = (rect, url, quads) =>
    doc.context.register(
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: rect,
        Border: [0, 0, 0],
        A: { S: 'URI', URI: PDFString.of(url) },
        ...(quads && { QuadPoints: quads }),
      }),
    );
  first.node.addAnnot(link([100, 400, 200, 420], 'https://example.org/'));
  first.node.addAnnot(
    link(
      [40, 375, 380, 420],
      'https://example.com/',
      [250, 420, 380, 420, 250, 400, 380, 400, 40, 395, 120, 395, 40, 375, 120, 375],
    ),
  );
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'link-wrap.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  const sheet = await page.locator('.drawing-overlay').boundingBox();
  const unit = sheet.width / 400;
  const at = (x, y) => ({ x: sheet.x + x * unit, y: sheet.y + (500 - y) * unit });
  const dialog = page.getByRole('dialog', { name: 'Edit link', exact: true });
  const address = dialog.getByRole('textbox', { name: 'Web address to link to' });
  const open = async (x, y, url) => {
    const point = at(x, y);
    await page.mouse.click(point.x, point.y);
    await expect(address).toHaveValue(url);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toBeHidden();
  };
  // The other link on the first line, inside the wrapped link's rectangle.
  await open(150, 410, 'https://example.org/');
  // Either line of the wrapped link.
  await open(300, 410, 'https://example.com/');
  await open(80, 385, 'https://example.com/');
  // The second line's words after the link are not part of it.
  const after = at(300, 385);
  expect(
    await page.evaluate(
      ({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.link-target'),
      after,
    ),
  ).toBe(false);
  // The keyboard still reaches the wrapped link as one link.
  await expect(page.getByRole('button', { name: 'Link to example.com', exact: true })).toHaveCount(
    1,
  );
});
