import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { inspectImages } from '../../src/core/image-edit.js';

const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=';

test('a selected picture smaller than its handles moves when dragged from its middle', async ({
  page,
}) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]).drawImage(await doc.embedPng(Buffer.from(PIXEL, 'base64')), {
    x: 300,
    y: 500,
    width: 12,
    height: 9,
  });
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await chooser
  ).setFiles({
    name: 'icon.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await page.getByRole('button', { name: 'Select image 1', exact: true }).press('Enter');
  const move = page.getByRole('button', { name: 'Move selected image', exact: true });
  await expect(move).toBeFocused();
  const frame = await move.boundingBox();
  const x = frame.x + frame.width / 2,
    y = frame.y + frame.height / 2;
  // The corner handles stand outside so small an object; its middle still moves it.
  expect(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.className, [x, y])).toBe(
    'image-move',
  );
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 40, y + 30, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = await PDFDocument.load(await readFile(await (await pending).path()));
  const [image] = inspectImages(saved, 0);
  expect(image.transform[0]).toBeCloseTo(12, 3);
  expect(image.transform[3]).toBeCloseTo(9, 3);
  expect(image.transform[4]).toBeGreaterThan(310);
  expect(image.transform[5]).toBeLessThan(495);
});
