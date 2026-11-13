import { test, expect } from '@playwright/test';
import { PDFDocument, rgb } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { inspectImages } from '../../src/core/image-edit.js';
import { inspectPaths } from '../../src/core/path-edit.js';

const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=';

async function open(page, doc, name = 'objects.pdf') {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await chooser
  ).setFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(await doc.save()) });
  await expect(page.locator('.page-caption')).toHaveText(`Page 1 of ${doc.getPageCount()}`);
}

async function download(page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  return PDFDocument.load(await readFile(await (await pending).path()));
}

for (const kind of ['image', 'shape'])
  test(`arrow keys stop a ${kind} at the page edge instead of pushing it out of sight`, async ({
    page,
  }) => {
    const doc = await PDFDocument.create();
    const sheet = doc.addPage([400, 400]);
    if (kind === 'image')
      sheet.drawImage(await doc.embedPng(Buffer.from(PIXEL, 'base64')), {
        x: 40,
        y: 200,
        width: 80,
        height: 60,
      });
    else sheet.drawRectangle({ x: 40, y: 200, width: 80, height: 60, color: rgb(0, 0.5, 0) });
    await open(page, doc);
    await page.getByRole('button', { name: `Select ${kind} 1`, exact: true }).click();
    const move = page.getByRole('button', { name: `Move selected ${kind}`, exact: true });
    await expect(move).toBeFocused();
    for (let i = 0; i < 20; i++) await move.press('Shift+ArrowLeft');
    await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
    const paper = await page.locator('.paper').boundingBox(),
      frame = await move.boundingBox();
    // As with a drag, a strip of the object stays on the page to select it by.
    expect(frame.x + frame.width).toBeGreaterThan(paper.x + 15);
    const saved = await download(page);
    const [object] = kind === 'image' ? inspectImages(saved, 0) : inspectPaths(saved, 0);
    const right = object.transform[4] + object.transform[0];
    expect(right).toBeGreaterThan(5);
    expect(right).toBeLessThan(20);
    // An object already at the edge stays put rather than jumping when pushed further.
    await move.press('Shift+ArrowLeft');
    await page.waitForTimeout(400);
    expect((await move.boundingBox()).x).toBeCloseTo(frame.x, 0);
  });
