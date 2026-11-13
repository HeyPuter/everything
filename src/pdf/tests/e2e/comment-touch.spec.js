import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { addShapeAnnotation, listAnnotations } from '../../src/core/annotations.js';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

test.skip(({ isMobile }) => !isMobile, 'touch screen');

/** A one-finger swipe from (x, y) by dy, as a touch screen sends it. */
async function swipe(page, x, y, dy) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= 10; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: y + (dy * i) / 10 }],
    });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

// On a phone, a swipe that began on a comment dragged the comment across the page instead of
// scrolling it, so a page covered by a large rectangle or text box could not be scrolled at all
// without moving the comment out of place.
test('a swipe over a comment scrolls the page; a tap chooses it and a finger then moves it', async ({
  page,
}) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  doc.addPage([612, 792]);
  addShapeAnnotation(doc, 0, {
    kind: 'square',
    rect: { x: 50, y: 100, width: 500, height: 600 },
    text: 'Large',
  });
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'comment-touch.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
  await settled(page);
  const target = page.getByRole('button', { name: 'Rectangle: Large', exact: true });
  const workspace = page.locator('.workspace');
  const before = await workspace.evaluate((node) => node.scrollTop);
  let box = await target.boundingBox();
  await swipe(page, box.x + box.width / 2, box.y + box.height - 20, -200);
  await settled(page);
  // The page scrolled, and the comment was neither moved nor chosen.
  await expect
    .poll(() => workspace.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(before + 100);
  await expect(target).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.save-status')).not.toHaveText('Unsaved changes');

  // A tap chooses it; once chosen, a finger drags it.
  await target.tap();
  await expect(target).toHaveAttribute('aria-pressed', 'true');
  box = await target.boundingBox();
  await swipe(page, box.x + box.width / 2, box.y + 30, 40);
  await settled(page);
  await expect(page.locator('.save-status')).toHaveText('Unsaved changes');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = await PDFDocument.load(await readFile(await (await pending).path()));
  const [moved] = listAnnotations(saved, 0);
  expect(moved.box.x).toBeCloseTo(50, 3);
  expect(moved.box.y).toBeLessThan(95);
});
