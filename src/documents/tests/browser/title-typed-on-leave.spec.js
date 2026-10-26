import { test, expect } from '@playwright/test';

const text = page => page.getByRole('textbox', { name: 'Document text' });

async function savedDocument(page) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await text(page).fill('Hello world.');
  await expect(page.locator('.canvas-save-status')).toHaveAttribute('aria-label', 'Saved to Puter', { timeout: 15000 });
}

test('a name typed in the title is kept when All Documents is pressed before confirming it', async ({ page }) => {
  await savedDocument(page);
  const title = page.getByRole('textbox', { name: 'Document name' });
  await title.click();
  await title.fill('Budget 2027');
  // The button keeps the keyboard where it is: the field never loses it, so nothing else confirms the name.
  await page.getByRole('button', { name: 'All Documents' }).first().click();
  await expect(page.getByRole('heading', { name: 'Your documents' })).toBeVisible();
  await expect(page.locator('.file-row .file-name')).toHaveText(['Budget 2027']);
});

test('a name abandoned with Escape is not applied on leaving', async ({ page }) => {
  await savedDocument(page);
  const title = page.getByRole('textbox', { name: 'Document name' });
  await title.click();
  await title.fill('Budget 2027');
  await title.press('Escape');
  await page.getByRole('button', { name: 'All Documents' }).first().click();
  await expect(page.getByRole('heading', { name: 'Your documents' })).toBeVisible();
  await expect(page.locator('.file-row .file-name')).toHaveText(['Untitled document']);
});
