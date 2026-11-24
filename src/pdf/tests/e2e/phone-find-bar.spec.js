import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';

// On a 320 px phone the find box was squeezed to its least (80 px, a short word filling it)
// and "No matches" broke onto two lines.
test.skip(({ isMobile }) => isMobile, 'sets its own phone width');

test('the find bar keeps room to type and its count on one line on the smallest phones', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([400, 500]).drawText('Quarterly report', { x: 40, y: 400, size: 14, font });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'find.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Find text or tools', exact: true }).click();
  const input = page.getByRole('combobox', { name: 'Find in PDF', exact: true });
  await input.fill('zzzz');
  const count = page.locator('.search-count');
  await expect(count).toHaveText('No matches');
  const [field, words, bar, close] = await Promise.all(
    [
      input,
      count,
      page.locator('.find-bar'),
      page.getByRole('button', { name: 'Close search' }),
    ].map((locator) => locator.evaluate((node) => node.getBoundingClientRect().toJSON())),
  );
  expect(field.width).toBeGreaterThanOrEqual(100);
  expect(words.height).toBeLessThan(16);
  expect(close.right).toBeLessThanOrEqual(bar.right);
});
