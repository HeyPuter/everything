import { test, expect } from '@playwright/test';
import { PDFDocument, rgb } from 'pdf-lib';

// Pages are told apart by colour: red, green, blue.
const COLOURS = [rgb(1, 0, 0), rgb(0, 0.6, 0), rgb(0, 0, 1)];
async function colouredPdf() {
  const doc = await PDFDocument.create();
  for (const color of COLOURS)
    doc.addPage([300, 400]).drawRectangle({ x: 0, y: 0, width: 300, height: 400, color });
  return Buffer.from(await doc.save());
}
/** The colour a page's picture in the continuous view shows, by its strongest channel. */
const shown = (page, index) =>
  page.locator(`.page-slot[data-page="${index}"]`).evaluate((slot) => {
    const canvas =
      slot.querySelector(':scope > .paper > canvas') || slot.querySelector('.page-image');
    if (!canvas?.width) return 'blank';
    const [r, g, b] = canvas
      .getContext('2d')
      .getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data;
    return r > 128 && g < 100 ? 'red' : g > 100 && r < 100 ? 'green' : b > 128 ? 'blue' : 'blank';
  });

test('the page left behind by Move page later shows the page now in its place', async ({
  page,
}) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({ name: 'colours.pdf', mimeType: 'application/pdf', buffer: await colouredPdf() });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 3');
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 3');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await expect.poll(() => shown(page, 1)).toBe('green');
  const bar = page.getByRole('menubar', { name: 'PDF menus' });
  if (await bar.isVisible()) await bar.getByRole('menuitem', { name: 'Page', exact: true }).click();
  else {
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Page', exact: true }).click();
  }
  await page.getByRole('menuitem', { name: 'Move page later', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 3 of 3');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  // Red, blue, green now: the second place holds the blue page, not a picture of the green one.
  await expect.poll(() => shown(page, 2)).toBe('green');
  await expect.poll(() => shown(page, 1), { timeout: 5000 }).toBe('blue');
  await expect.poll(() => shown(page, 0)).toBe('red');
});
