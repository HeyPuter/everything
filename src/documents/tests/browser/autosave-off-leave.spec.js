import { test, expect } from '@playwright/test';
import { unzipSync, strFromU8 } from 'fflate';

/**
 * With AutoSave off only Save writes the file. Leaving the document (All Documents, or the Puter window's close
 * button) with changes Save has not written asks whether to save them, as closing does in a desktop word
 * processor: leaving used to write them without asking, so an experiment the user meant to throw away
 * replaced the file.
 */

const text = page => page.getByRole('textbox', { name: 'Document text' });
const status = page => page.locator('.canvas-save-status');
async function fileText(page, path) {
  const bytes = await page.evaluate(async p => [...new Uint8Array(await (await puter.fs.read(p)).arrayBuffer())], path);
  const xml = strFromU8(unzipSync(Uint8Array.from(bytes))['word/document.xml']);
  return [...xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map(m => m[1]).join('');
}

async function savedWithAutoSaveOff(page, query = '') {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/mock.html${query}#/new`);
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await text(page).fill('Kept');
  await text(page).press('ControlOrMeta+s');
  await expect(status(page)).toHaveAttribute('aria-label', 'Saved to Puter');
  await page.locator('label.ed-autosave').click();
  await expect(page.getByRole('switch', { name: 'AutoSave' })).not.toBeChecked();
  await text(page).press('End');
  await page.keyboard.type(' experiment');
  await expect(status(page)).toHaveAttribute('aria-label', 'Unsaved changes');
  return page.evaluate(() => window.__docs.current.view.doc.path);
}

test.afterEach(async ({ page }) => { await page.evaluate(() => localStorage.removeItem('documents:autosave')).catch(() => {}); });

test('leaving with AutoSave off asks before saving; Don’t Save keeps the file as it was', async ({ page }) => {
  const path = await savedWithAutoSaveOff(page);
  await page.getByRole('button', { name: 'All Documents' }).click();
  const question = page.getByRole('dialog', { name: 'Save changes?' });
  await expect(question).toBeVisible();
  // Cancel stays in the document with its changes.
  await question.getByRole('button', { name: 'Cancel' }).click();
  await expect(question).toHaveCount(0);
  await expect(text(page)).toHaveValue('Kept experiment');
  expect(await fileText(page, path)).toBe('Kept');
  await page.getByRole('button', { name: 'All Documents' }).click();
  await question.getByRole('button', { name: 'Don’t Save' }).click();
  await expect(page.locator('.file-row .file-name')).toHaveText(['Untitled document']);
  expect(await fileText(page, path)).toBe('Kept');
});

test('leaving with AutoSave off and choosing Save writes the changes', async ({ page }) => {
  const path = await savedWithAutoSaveOff(page);
  await page.getByRole('button', { name: 'All Documents' }).click();
  await page.getByRole('dialog', { name: 'Save changes?' }).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.file-row .file-name')).toHaveText(['Untitled document']);
  expect(await fileText(page, path)).toBe('Kept experiment');
});

test('the Puter window’s close button asks too with AutoSave off', async ({ page }) => {
  const path = await savedWithAutoSaveOff(page, '?env=app');
  const closing = page.evaluate(() => window.__closeWindow());
  const question = page.getByRole('dialog', { name: 'Save changes?' });
  await question.getByRole('button', { name: 'Don’t Save' }).click();
  expect(await closing).toBe(true);
  expect(await page.evaluate(() => window.__exits || 0)).toBe(1);
  expect(await fileText(page, path)).toBe('Kept');
});
