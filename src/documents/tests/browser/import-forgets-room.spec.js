import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const text = page => page.getByRole('textbox', { name: 'Document text' });
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

test('a document imported under the name of a shared one deleted elsewhere does not join its room', async ({ page }) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html?user=ada#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await text(page).fill('Quarterly plan.');
  await page.getByRole('button', { name: 'Share', exact: true }).first().click();
  await page.getByRole('menuitem', { name: 'Copy Link' }).click();
  await expect(page.locator('.cl-avatar')).toHaveCount(1, { timeout: 15000 });
  await expect(page.locator('.canvas-save-status')).toHaveAttribute('aria-label', 'Saved to Puter', { timeout: 15000 });
  const path = await page.evaluate(() => window.__docs.current.view.doc.path);
  expect(path).toBe('Documents/Untitled document.docx');
  await page.evaluate(() => { location.hash = '#/home'; });
  await expect(page.getByRole('heading', { name: 'Your documents' })).toBeVisible();
  // Deleted outside the app (the Puter desktop), so the app never forgot its room.
  await page.evaluate(p => window.puter.fs.delete(p), path);
  const bytes = readFileSync(new URL('../fixtures/aligned-tab-tails/source.docx', import.meta.url));
  await page.locator('input[type="file"]').first().setInputFiles([
    { name: 'Untitled document.docx', mimeType: DOCX, buffer: bytes },
    { name: 'Other.docx', mimeType: DOCX, buffer: bytes },
  ]);
  const row = page.locator('.file-row', { hasText: 'Untitled document' });
  await expect(row).toHaveCount(1, { timeout: 15000 });
  await row.locator('.file-main').click();
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled({ timeout: 15000 });
  await page.waitForTimeout(1500);
  await expect(page.locator('.cl-avatar')).toHaveCount(0);
  await expect(text(page)).not.toHaveValue('Quarterly plan.');
});
