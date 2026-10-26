import { test, expect } from '@playwright/test';

const text = page => page.getByRole('textbox', { name: 'Document text' });

// The local mock's drive keeps a file's id through a rename, as Puter does: the document list finds a document
// saved elsewhere by it, so renaming one from the list must not make it disappear.
test('a document saved elsewhere stays listed after it is renamed from the list', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/mock.html?env=app#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await text(page).fill('Hello world.');
  const title = page.getByRole('textbox', { name: 'Document name' });
  await title.fill('Report');
  await title.press('Enter');
  await text(page).press('ControlOrMeta+s');
  await expect(page.locator('.canvas-save-status')).toHaveAttribute('aria-label', 'Saved to Puter', { timeout: 15000 });
  await page.evaluate(() => { location.hash = '#/home'; });
  await expect(page.locator('.file-row .file-name')).toHaveText(['Report']);
  await page.getByRole('button', { name: 'Options for Report.docx' }).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await page.getByRole('textbox', { name: 'Name' }).fill('Report 2');
  await page.getByRole('dialog', { name: 'Rename' }).getByRole('button', { name: 'Rename' }).click();
  await expect(page.locator('.file-row .file-name')).toHaveText(['Report 2']);
  await page.locator('.file-row .file-main').click();
  await expect(text(page)).toHaveValue('Hello world.');
  expect(await page.evaluate(() => window.__docs.current.view.doc.path)).toBe('~/Desktop/Report 2.docx');
});
