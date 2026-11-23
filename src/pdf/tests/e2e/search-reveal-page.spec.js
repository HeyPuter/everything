import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';

// Find centers a match that is out of view. A match near the top of the page, reached from
// lower on that same page, was centered so far down that the page above came under the
// middle of the view; the view then took that page for the current one, the match lost its
// highlight, and the count named a match on a page no longer shown.
test('a match near the top of the page stays current when Find scrolls up to it', async ({
  page,
}) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([612, 792]).drawText('First page', { x: 50, y: 700, size: 14, font });
  const second = doc.addPage([612, 792]);
  second.drawText('alpha near the top', { x: 50, y: 720, size: 14, font });
  second.drawText('omega near the bottom', { x: 50, y: 60, size: 14, font });
  doc.addPage([612, 792]);
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'search-reveal.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 3');
  await page.getByRole('button', { name: 'Find text or tools', exact: true }).click();
  const find = page.getByRole('combobox', { name: 'Find in PDF', exact: true });
  await find.fill('omega');
  await expect(page.locator('.search-count')).toHaveText('1 of 1');
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 3');
  await expect(page.locator('.search-hit-current')).toHaveText('omega');
  await find.fill('alpha');
  await expect(page.locator('.search-count')).toHaveText('1 of 1');
  await expect(page.locator('.search-hit-current')).toHaveText('alpha');
  // The view settles on a scroll's page a moment after it stops.
  await page.waitForTimeout(600);
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 3');
  await expect(page.locator('.search-hit-current')).toHaveText('alpha');
  await expect(page.locator('.search-hit-current')).toBeInViewport();
});
