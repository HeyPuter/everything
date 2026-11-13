import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';

// A fitted page is redrawn at a new zoom when the window or a panel changes the view's size.
// Every page above it changes height then, and the page being read has to stay in view: it
// used to drift away (to page 538 of a 1,000-page PDF while the page box still said 500).
async function longPdf(count = 40) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < count; i++)
    doc.addPage([612, 792]).drawText(`Page ${i + 1}`, { x: 40, y: 700, size: 24, font });
  return doc;
}

async function open(page, doc) {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'long.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText(`Page 1 of ${doc.getPageCount()}`);
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
}

/** Whether the page's slot shows in the scrolling view. */
const inView = (page, index) =>
  page.evaluate((index) => {
    const view = document.querySelector('.workspace').getBoundingClientRect();
    const box = document.querySelector(`.page-slot[data-page="${index}"]`).getBoundingClientRect();
    return box.bottom > view.top + 40 && box.top < view.bottom - 40;
  }, index);

test('a refit after the window narrows keeps the current page in view', async ({ page }) => {
  test.skip(test.info().project.name === 'mobile', 'The window is resized on the desktop.');
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page, await longPdf());
  const number = page.getByLabel('Page number', { exact: true });
  await number.fill('30');
  await number.press('Enter');
  await expect(page.locator('.page-caption')).toHaveText('Page 30 of 40');
  await expect.poll(() => inView(page, 29)).toBe(true);
  const width = () => page.locator('.page-slot[data-page="29"]').evaluate((n) => n.offsetWidth);
  const before = await width();
  await page.setViewportSize({ width: 900, height: 800 });
  // The page is fitted to the narrower view...
  await expect.poll(width).toBeLessThan(before - 20);
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  // ...and is still the one on screen, as the page box says.
  expect(await inView(page, 29)).toBe(true);
  await expect(number).toHaveValue('30');
});
