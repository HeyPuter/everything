import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { inspectImages } from '../../src/core/image-edit.js';

const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=';

// On a zoomed page a picture could be dragged only as far as the part of the page in view: the
// view did not scroll when the drag reached its edge.
test('a picture dragged to the edge of the page view scrolls it to the rest of the page', async ({
  page,
}) => {
  test.skip(test.info().project.name === 'mobile', 'A mouse drag on the desktop layout.');
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]).drawImage(await doc.embedPng(Buffer.from(PIXEL, 'base64')), {
    x: 300,
    y: 650,
    width: 80,
    height: 60,
  });
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await chooser
  ).setFiles({
    name: 'tall.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await page.getByLabel('Zoom', { exact: true }).selectOption('2');
  const workspace = page.locator('.workspace');
  await page.getByRole('button', { name: 'Select image 1', exact: true }).click();
  const move = page.getByRole('button', { name: 'Move selected image', exact: true });
  await expect(move).toBeFocused();
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  const frame = await move.boundingBox(),
    view = await workspace.boundingBox();
  expect(await workspace.evaluate((node) => node.scrollTop)).toBe(0);
  const x = frame.x + 20,
    y = frame.y + 20,
    bottom = view.y + view.height - 10;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(x, y + ((bottom - y) * i) / 10);
  // Held at the edge, the view keeps scrolling down to the end of the page.
  await expect
    .poll(() =>
      workspace.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop),
    )
    .toBeLessThan(2);
  await page.mouse.up();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const [image] = inspectImages(
    await PDFDocument.load(await readFile(await (await pending).path())),
    0,
  );
  // Near the foot of the page, beyond what was in view when the drag began.
  expect(image.transform[5]).toBeLessThan(200);
});
