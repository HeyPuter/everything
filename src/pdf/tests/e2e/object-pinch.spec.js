import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=';

// A pinch on a selected picture (a scanned page, one picture from edge to edge, say) moved the
// picture with the first finger and saved that as an edit, and the page did not zoom.
test('two fingers on a selected picture zoom the page and leave the picture where it was', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'mobile', 'Pinching takes a touch screen.');
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]).drawImage(await doc.embedPng(Buffer.from(PIXEL, 'base64')), {
    x: 0,
    y: 0,
    width: 612,
    height: 792,
  });
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await chooser
  ).setFiles({
    name: 'scan.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
  const target = await page
    .getByRole('button', { name: 'Select image 1', exact: true })
    .boundingBox();
  const x = target.x + target.width / 2,
    y = target.y + Math.min(target.height, 400) / 2;
  await touch('touchStart', [{ id: 1, x, y }]);
  await touch('touchEnd', []);
  const move = page.getByRole('button', { name: 'Move selected image', exact: true });
  await expect(move).toBeVisible();
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  const before = await move.boundingBox();
  const zoom = page.getByLabel('Zoom', { exact: true });
  const zoomBefore = await zoom.inputValue();
  await touch('touchStart', [
    { id: 1, x: x - 30, y },
    { id: 2, x: x + 30, y },
  ]);
  for (let i = 1; i <= 5; i++)
    await touch('touchMove', [
      { id: 1, x: x - 30 - i * 12, y: y + i * 3 },
      { id: 2, x: x + 30 + i * 12, y: y + i * 3 },
    ]);
  await touch('touchEnd', []);
  await expect(zoom).not.toHaveValue(zoomBefore);
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect(page.locator('.save-status')).toHaveText('Local file');
  // Still selected, and as large as the zoom makes it.
  const after = await move.boundingBox();
  expect(after.width / before.width).toBeGreaterThan(1.5);
});
