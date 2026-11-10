import { test, expect } from '@playwright/test';

const text = page => page.getByRole('textbox', { name: 'Document text' });

/** A document renamed in the Puter desktop while it is open here follows the file and goes on saving there. */
test('a document renamed elsewhere while open follows its file', async ({ page }) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await text(page).fill('Quarterly plan.');
  const status = page.locator('.canvas-save-status');
  await expect(status).toHaveAttribute('aria-label', 'Saved to Puter', { timeout: 10000 });
  const from = decodeURIComponent((await page.evaluate(() => location.hash)).replace(/^#\/edit\//, ''));
  // The desktop renames it.
  await page.evaluate(path => puter.fs.rename(path, 'Budget.docx'), from);
  await text(page).evaluate(el => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); el.dispatchEvent(new Event('select')); });
  await text(page).pressSequentially(' Revised.');
  await expect.poll(() => page.evaluate(() => decodeURIComponent(location.hash)), { timeout: 10000 }).toBe('#/edit/Documents/Budget.docx');
  await expect(status).toHaveAttribute('aria-label', 'Saved to Puter', { timeout: 10000 });
  await expect(page.getByRole('textbox', { name: 'Document name' })).toHaveValue('Budget');
  await expect(page.locator('.toast')).toHaveCount(0);
  const files = await page.evaluate(async () => (await puter.fs.readdir('Documents')).map(f => f.name).filter(n => n.endsWith('.docx')));
  expect(files).toEqual(['Budget.docx']);
});
