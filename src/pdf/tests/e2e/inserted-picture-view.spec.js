import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=';

test('a picture inserted on a phone is scrolled into view above the properties dock', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 664 });
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await chooser
  ).setFiles({
    name: 'blank.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  const picker = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Image', exact: true }).first().click();
  await (
    await picker
  ).setFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: Buffer.from(PIXEL, 'base64') });
  await expect(page.locator('#toast')).toHaveText('Image added. Drag to move or resize it.');
  const move = page.getByRole('button', { name: 'Move selected image', exact: true });
  await expect(move).toBeVisible();
  await expect(page.getByRole('group', { name: 'Edit image' })).toBeVisible();
  // Like a placed signature or stamp, the whole picture and its corner handles are in view.
  await expect
    .poll(async () => {
      const view = await page.locator('.workspace').boundingBox(),
        frame = await move.boundingBox();
      return frame.y >= view.y && frame.y + frame.height <= view.y + view.height;
    })
    .toBe(true);
});
