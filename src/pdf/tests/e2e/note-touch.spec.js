import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

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

// With the Note tool on a phone, a swipe anywhere on the page opened a new note where the
// finger first came down, and the page did not scroll, so notes could be added only to the
// part of the page in view when the tool was chosen.
test('with the Note tool a swipe scrolls the page and a tap adds a note', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  doc.addPage([612, 792]);
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'note-touch.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
  await settled(page);
  await page.getByRole('button', { name: 'Note', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Note', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const workspace = page.locator('.workspace');
  const before = await workspace.evaluate((node) => node.scrollTop);
  const box = await page.locator('.paper').boundingBox();
  const viewport = page.viewportSize();
  const x = box.x + box.width / 2;
  const y = Math.min(box.y + box.height - 40, viewport.height - 150);
  await swipe(page, x, y, -200);
  await settled(page);
  await expect
    .poll(() => workspace.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(before + 100);
  const note = page.getByRole('textbox', { name: 'New note text', exact: true });
  await expect(note).toHaveCount(0);

  await page.touchscreen.tap(x, y - 100);
  await expect(note).toBeVisible();
  await expect(note).toBeFocused();
});
