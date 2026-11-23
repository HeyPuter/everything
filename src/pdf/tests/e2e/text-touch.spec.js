import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { readFile } from 'node:fs/promises';

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

// On a phone, a swipe that began on a line of text in Select mode picked the line up and
// dragged it across the page instead of scrolling, so a page full of text could hardly be
// scrolled at all without moving its lines out of place.
test('a swipe over text scrolls the page; a tap selects the line and a finger then moves it', async ({
  page,
}) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const first = doc.addPage([612, 792]);
  for (let i = 0; i < 14; i++)
    first.drawText(`Line ${i + 1} of the text`, { x: 40, y: 740 - i * 50, size: 40, font });
  doc.addPage([612, 792]);
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'text-touch.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
  await settled(page);
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const target = page.getByRole('button', { name: /^Edit text: Line 1 of the text/ });
  const workspace = page.locator('.workspace');
  const before = await workspace.evaluate((node) => node.scrollTop);
  let box = await target.boundingBox();
  const viewport = page.viewportSize();
  const y = Math.min(box.y + box.height - 20, viewport.height - 150);
  await swipe(page, box.x + box.width / 2, y, -200);
  await settled(page);
  // The page scrolled, and the line was neither moved nor selected.
  await expect
    .poll(() => workspace.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(before + 100);
  await expect(page.getByRole('button', { name: 'Move text', exact: true })).toHaveCount(0);
  await expect(page.locator('.save-status')).not.toHaveText('Unsaved changes');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();

  // A tap selects the line; once selected, a finger drags it.
  await target.tap();
  const move = page.getByRole('button', { name: 'Move text', exact: true });
  await expect(move).toHaveCount(1);
  const input = page.locator('.page-text-input');
  await expect(input).toHaveClass(/text-object-selected/);
  box = await input.boundingBox();
  await swipe(page, box.x + box.width / 2, Math.max(box.y, 0) + 60, 40);
  await settled(page);
  await expect(page.locator('.save-status')).toHaveText('Unsaved changes');
});

test('a double tap on text starts typing in it', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([612, 792]).drawText('Tap me twice', { x: 40, y: 700, size: 40, font });
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'text-touch.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);
  const box = await page.getByRole('button', { name: 'Edit text: Tap me twice' }).boundingBox();
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const cdp = await page.context().newCDPSession(page);
  for (let i = 0; i < 2; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  await cdp.detach();
  const input = page.getByRole('textbox', { name: 'Edit text', exact: true });
  await expect(input).toBeFocused();
  await expect(input).not.toHaveClass(/text-object-selected/);
});
