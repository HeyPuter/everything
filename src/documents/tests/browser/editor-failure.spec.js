import { test, expect } from '@playwright/test';

const fileButton = page => page.getByRole('button', { name: 'File', exact: true });

// A file that is not a DOCX archive cannot open.
async function openTextImport(page) {
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.locator('input[type=file][aria-label="Open DOCX file"]').setInputFiles({ name: 'damaged.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('not a zip') });
}

test('a document that cannot open keeps the header and offers ways forward', async ({ page }) => {
  await openTextImport(page);
  const message = page.locator('.canvas-message.editor-error');
  await expect(message).toBeVisible();
  for (const name of ['Back to documents', 'New document']) await expect(message.getByRole('button', { name, exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Back to documents', exact: true }).first()).toBeVisible();
  await expect(fileButton(page)).toBeVisible();
  await expect(page.locator('.ribbon-card')).toBeHidden();
  // The message does not cover the header: its top is below it.
  const header = await page.locator('.canvas-header').boundingBox(), box = await message.boundingBox();
  expect(box.y).toBeGreaterThanOrEqual(header.y + header.height - 1);
  await message.getByRole('button', { name: 'New document', exact: true }).click();
  // The unopened import is unsaved, so leaving it asks first, as any navigation does.
  await page.locator('.modal-root:not(.closing)').getByRole('button', { name: 'Leave without saving', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await expect(page.getByRole('textbox', { name: 'Document text' })).toHaveValue('');

  await openTextImport(page);
  await expect(message).toBeVisible();
  await message.getByRole('button', { name: 'Back to documents', exact: true }).click();
  await page.locator('.modal-root:not(.closing)').getByRole('button', { name: 'Leave without saving', exact: true }).click();
  await expect(page).toHaveURL(/#\/home$/);
  await expect(page.getByRole('heading', { name: 'Your documents' })).toBeVisible();
});

test('a damaged file keeps its original available beside the navigation', async ({ page }) => {
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.locator('input[type=file][aria-label="Open DOCX file"]').setInputFiles({ name: 'broken.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('not a zip') });
  const message = page.locator('.canvas-message.editor-error');
  await expect(message).toContainText('Could not read this DOCX archive');
  const download = page.waitForEvent('download');
  await message.getByRole('button', { name: 'Download original', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('broken.docx');
  await expect(fileButton(page)).toBeVisible();
});
