import { test, expect } from '@playwright/test';

// The find box offers tools as well as finding words in the PDF.
test.beforeEach(async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.goto('/');
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await page.keyboard.press('ControlOrMeta+f');
});

const option = (page, label) =>
  page.getByRole('option', { name: `Open tool: ${label}`, exact: true });

test('several words find a tool whose words are not side by side', async ({ page }) => {
  const find = page.getByRole('combobox', { name: 'Find in PDF', exact: true });
  // Organize pages deletes pages, and Edit a PDF changes text: neither says so in those words.
  await find.fill('delete page');
  await expect(option(page, 'Organize pages')).toBeVisible();
  await find.fill('edit text');
  await expect(option(page, 'Edit a PDF')).toBeVisible();
  await find.fill('pages delete');
  await expect(option(page, 'Organize pages')).toBeVisible();
  // Every word must still be found, from its start.
  await find.fill('delete otter');
  await expect(page.getByRole('listbox', { name: 'Matching tools' })).toBeHidden();
  await expect(find).toHaveAttribute('aria-expanded', 'false');
});

test('the everyday names of formats and tasks offer their tools', async ({ page }) => {
  const find = page.getByRole('combobox', { name: 'Find in PDF', exact: true });
  for (const [words, tool] of [
    ['word', 'Export a PDF'],
    ['docx', 'Export a PDF'],
    ['excel', 'Export a PDF'],
    ['powerpoint', 'Export a PDF'],
    ['jpg', 'Export a PDF'],
    ['encrypt', 'Protect a PDF'],
    ['remove password', 'Protect a PDF'],
    ['reduce size', 'Compress a PDF'],
    ['hyperlink', 'Edit a PDF'],
    ['metadata', 'Document properties'],
  ]) {
    await find.fill(words);
    await expect(option(page, tool)).toBeVisible();
  }
});
