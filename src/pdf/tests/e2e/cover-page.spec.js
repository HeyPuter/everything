import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName } from 'pdf-lib';

async function open(page, layout) {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  for (let i = 0; i < 5; i++) doc.addPage([400, 500]);
  doc.catalog.set(PDFName.of('PageLayout'), PDFName.of(layout));
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'book.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
}
/** The pages on view, each with its place: [page number, left, top]. */
const shown = (page) =>
  page.locator('.page-slot:not([hidden])').evaluateAll((slots) =>
    slots.map((slot) => {
      const box = slot.getBoundingClientRect();
      return [Number(slot.dataset.page) + 1, Math.round(box.left), Math.round(box.top)];
    }),
  );

// A book laid out TwoPageRight or TwoColumnRight shows page 1 alone, as its cover, so that the
// pages after it face as printed: 2 beside 3, 4 beside 5. It used to pair 1 with 2.
test('a PDF that opens with a cover page shows its spreads as a book does', async ({ page }) => {
  await open(page, 'TwoPageRight');
  await expect.poll(async () => (await shown(page)).map(([n]) => n)).toEqual([1]);
  const next = page.getByRole('button', { name: 'Next page', exact: true });
  await next.click();
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 5');
  await expect.poll(async () => (await shown(page)).map(([n]) => n)).toEqual([2, 3]);
  const [[, left2, top2], [, left3, top3]] = await shown(page);
  expect(left2).toBeLessThan(left3);
  expect(top2).toBe(top3);
  await next.click();
  await expect(page.locator('.page-caption')).toHaveText('Page 4 of 5');
  await expect.poll(async () => (await shown(page)).map(([n]) => n)).toEqual([4, 5]);
  await expect(next).toBeDisabled();
  await page.getByRole('button', { name: 'Previous page', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 5');
});

test('Show cover page in the View menu sets the spreads apart or together', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'The View menu is in the menu bar on a desktop.');
  await open(page, 'TwoColumnRight');
  const place = async (n) => (await shown(page)).find(([number]) => number === n);
  // The cover sits alone on the right; pages 2 and 3 share the next row.
  await expect.poll(async () => (await place(1))[1]).toBeGreaterThan((await place(2))[1]);
  expect((await place(2))[2]).toBe((await place(3))[2]);
  expect((await place(1))[2]).toBeLessThan((await place(2))[2]);
  const bar = page.getByRole('menubar', { name: 'PDF menus' });
  await bar.getByRole('menuitem', { name: 'View', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Page display' }).click();
  await page.getByText('Show cover page', { exact: true }).click();
  // Page 1 beside page 2 again.
  await expect.poll(async () => (await place(1))[2]).toBe((await place(2))[2]);
  expect((await place(1))[1]).toBeLessThan((await place(2))[1]);
});
