import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';

async function open(page) {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 3; i++)
    doc.addPage([300, 400]).drawText(`Chapter ${i}`, { x: 40, y: 300, size: 20, font });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'book.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 3');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  if (!(await page.getByRole('complementary', { name: 'Tools' }).isVisible()))
    await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page
    .getByRole('complementary', { name: 'Tools' })
    .getByRole('button', { name: 'Organize pages', exact: true })
    .click();
  const grid = page.getByRole('listbox', { name: 'Pages' });
  await expect(grid).toBeVisible();
  return grid;
}

for (const how of ['shortcut', 'button'])
  test(`Find (${how}) in Organize pages returns to the pages and finds there`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile && how === 'shortcut', 'no keyboard shortcuts on a phone');
    const grid = await open(page);
    if (how === 'shortcut') {
      await grid.getByRole('option').first().focus();
      await page.keyboard.press('ControlOrMeta+f');
    } else await page.getByRole('button', { name: 'Find text or tools', exact: true }).click();
    const find = page.getByRole('combobox', { name: 'Find in PDF' });
    await expect(find).toBeVisible();
    await expect(find).toBeFocused();
    await expect(grid).toBeHidden();
    await find.fill('Chapter 3');
    await find.press('Enter');
    await expect(page.locator('.page-caption')).toHaveText('Page 3 of 3');
  });
