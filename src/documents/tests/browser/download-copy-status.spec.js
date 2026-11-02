import { test, expect } from '@playwright/test';

// Downloading a copy of a document saved on Puter leaves the Puter file as it was: the status still says whether
// the document's own file has the edits. It used to say "Downloaded", hiding "Unsaved changes" with AutoSave off.
const text = page => page.getByRole('textbox', { name: 'Document text' });
const status = page => page.locator('.canvas-save-status');

test('downloading a copy does not report a document with unsaved changes as done', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await text(page).fill('Kept');
  await expect(status(page)).toHaveAttribute('aria-label', 'Saved to Puter');
  await page.locator('label.ed-autosave').click();
  await expect(page.getByRole('switch', { name: 'AutoSave' })).not.toBeChecked();
  await text(page).press('End'); await page.keyboard.type(' more');
  await expect(status(page)).toHaveAttribute('aria-label', 'Unsaved changes');
  await page.getByRole('menubar', { name: 'Menu bar' }).getByRole('menuitem', { name: 'File', exact: true }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download a Copy' }).click()]);
  expect(download.suggestedFilename()).toBe('Untitled document.docx');
  await page.waitForTimeout(300);
  await expect(status(page)).toHaveAttribute('aria-label', 'Unsaved changes');
  // Turned back on, AutoSave writes the edits.
  await page.locator('label.ed-autosave').click();
  await expect(status(page)).toHaveAttribute('aria-label', 'Saved to Puter');
});
