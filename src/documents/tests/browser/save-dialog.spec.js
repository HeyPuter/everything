import { test, expect } from '@playwright/test';

/**
 * Inside the Puter desktop (the mock's ?env=app) a new document is saved where the user chooses, with Puter's
 * Save dialog, and only when the user asks. The mock's dialog saves under ~/Desktop, or cancels when a test sets
 * window.__puterSaveAs to null.
 */

const text = page => page.getByRole('textbox', { name: 'Document text' });
const status = page => page.locator('.canvas-save-status');
const drive = page => page.evaluate(() => Object.keys(JSON.parse(sessionStorage.getItem('documents-mock-state') || '{"fs":{}}').fs));
const docPath = page => page.evaluate(() => window.__docs.current.view.doc.path);

async function openEditor(page, hash = '#/new') {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/mock.html?env=app${hash}`);
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.evaluate(() => {
    window.__dialogs = [];
    const show = puter.ui.showSaveFilePicker;
    puter.ui.showSaveFilePicker = function (data, name) { window.__dialogs.push(name); return show.call(this, data, name); };
  });
}

test('a new document is not saved until Save, which asks where and then autosaves there', async ({ page }) => {
  await openEditor(page);
  await text(page).fill('First draft');
  await expect(status(page)).toHaveAttribute('aria-label', 'Not saved yet');
  await page.waitForTimeout(2500);
  expect(await drive(page)).toEqual([]);
  expect(await page.evaluate(() => window.__dialogs)).toEqual([]);
  await text(page).press('ControlOrMeta+s');
  await expect(status(page)).toHaveAttribute('aria-label', 'Saved to Puter');
  expect(await page.evaluate(() => window.__dialogs)).toEqual(['Untitled document.docx']);
  expect(await docPath(page)).toBe('~/Desktop/Untitled document.docx');
  await expect(page).toHaveURL(/#\/edit\/~%2FDesktop%2FUntitled%20document\.docx$/);
  await page.keyboard.type(' and more');
  await expect(status(page)).toHaveAttribute('aria-label', 'Unsaved changes');
  await expect(status(page)).toHaveAttribute('aria-label', 'Saved to Puter');
  expect(await drive(page)).toEqual(['~/Desktop/Untitled document.docx']);
  expect(await page.evaluate(() => window.__dialogs)).toHaveLength(1);
});

test('cancelling the Save dialog leaves the document unsaved without an error', async ({ page }) => {
  await openEditor(page);
  await text(page).fill('Draft');
  await page.evaluate(() => { window.__puterSaveAs = null; });
  await text(page).press('ControlOrMeta+s');
  await expect.poll(() => page.evaluate(() => window.__dialogs.length)).toBe(1);
  await page.waitForTimeout(500);
  await expect(status(page)).toHaveAttribute('aria-label', 'Not saved yet');
  await expect(page.locator('.toast-root')).not.toContainText(/./);
  expect(await docPath(page)).toBeNull();
  expect(await drive(page)).toEqual([]);
});

test('leaving a new document asks where to save it; cancelling asks whether to leave', async ({ page }) => {
  await openEditor(page);
  await text(page).fill('Draft');
  await page.evaluate(() => { window.__puterSaveAs = null; });
  await page.evaluate(() => { location.hash = '#/home'; });
  const dialog = page.getByRole('dialog', { name: 'Leave without saving?' });
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => window.__dialogs)).toEqual(['Untitled document.docx']);
  await expect(page.locator('.toast-root')).not.toContainText(/./);
  await page.evaluate(() => { window.__puterSaveAs = 'Kept.docx'; });
  await dialog.getByRole('button', { name: 'Keep editing' }).click();
  await page.evaluate(() => { location.hash = '#/home'; });
  await expect(page.getByRole('heading', { name: 'Your documents' })).toBeVisible();
  expect(await drive(page)).toEqual(['~/Desktop/Kept.docx']);
});

test('a document saved elsewhere through the Save dialog is listed on the documents screen and in Open recent', async ({ page }) => {
  await openEditor(page);
  await text(page).fill('Plans');
  await page.evaluate(() => { window.__puterSaveAs = 'Plans.docx'; });
  await text(page).press('ControlOrMeta+s');
  await expect(status(page)).toHaveAttribute('aria-label', 'Saved to Puter');
  await page.evaluate(() => { location.hash = '#/home'; });
  const row = page.locator('[data-path="~/Desktop/Plans.docx"]');
  await expect(row).toBeVisible();
  await expect(row.locator('.file-meta')).toContainText('Desktop');
  await expect(row.locator('.file-main')).toHaveAttribute('title', 'Plans.docx in Desktop');
  // A new document lists the first in Open recent.
  await page.getByRole('button', { name: 'New document' }).first().click();
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'File', exact: true }).click();
  const view = page.getByRole('dialog', { name: 'File' });
  await view.getByRole('tab', { name: 'Open' }).click();
  await expect(view.getByRole('button', { name: /^Plans/ })).toBeVisible();
});

test('File > Save: Save a Copy asks where and goes on in the copy', async ({ page }) => {
  await openEditor(page);
  await text(page).fill('Original');
  await text(page).press('ControlOrMeta+s');
  await expect(status(page)).toHaveAttribute('aria-label', 'Saved to Puter');
  await page.getByRole('button', { name: 'File', exact: true }).click();
  const view = page.getByRole('dialog', { name: 'File' });
  await view.getByRole('tab', { name: 'Save' }).click();
  await expect(view.getByRole('textbox', { name: 'New file name' })).toHaveCount(0);
  await view.getByRole('button', { name: 'Save a Copy…' }).click();
  await expect(view.getByRole('status').filter({ hasText: /Saved/ })).toHaveText('Saved. You are now editing the copy.');
  expect(await page.evaluate(() => window.__dialogs)).toEqual(['Untitled document.docx', 'Untitled document copy.docx']);
  expect(await docPath(page)).toBe('~/Desktop/Untitled document copy.docx');
  await expect(page.getByRole('textbox', { name: 'Document name' })).toHaveValue('Untitled document copy');
});

test('time spent in the Save dialog while leaving is not reported as a stalled save', async ({ page }) => {
  test.setTimeout(60000);
  await openEditor(page);
  await text(page).fill('Draft');
  // The user takes longer to choose than a stalled save is given.
  await page.evaluate(() => {
    const show = puter.ui.showSaveFilePicker;
    puter.ui.showSaveFilePicker = function (data, name) {
      const answer = new Promise(resolve => setTimeout(resolve, 16500)).then(() => show.call(this, data, name));
      const saved = answer.then(item => item);
      saved.undefinedOnCancel = answer;
      return saved;
    };
  });
  await page.evaluate(() => { location.hash = '#/home'; });
  await expect(page.getByRole('heading', { name: 'Your documents' })).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.toast-root')).not.toContainText('Saving is taking longer than usual');
  await expect(page.getByRole('dialog', { name: 'Leave without saving?' })).toHaveCount(0);
  expect(await drive(page)).toEqual(['~/Desktop/Untitled document.docx']);
});

test('File > Export downloads every format to this device, without the Save dialog', async ({ page }) => {
  await openEditor(page);
  await text(page).fill('Exported');
  await text(page).press('ControlOrMeta+s');
  await expect(status(page)).toHaveAttribute('aria-label', 'Saved to Puter');
  const before = await drive(page);
  const tiles = [['Word document', 'Untitled document.docx'], ['PDF', 'Untitled document.pdf'], ['Web page', 'Untitled document.html'], ['Markdown', 'Untitled document.md'], ['Plain text', 'Untitled document.txt']];
  for (const [tile, file] of tiles) {
    await page.getByRole('button', { name: 'File', exact: true }).click();
    const view = page.getByRole('dialog', { name: 'File' });
    await view.getByRole('tab', { name: 'Export' }).click();
    const [download] = await Promise.all([page.waitForEvent('download'), view.getByRole('button', { name: new RegExp(`^${tile}`) }).click()]);
    expect(download.suggestedFilename()).toBe(file);
  }
  expect(await page.evaluate(() => window.__dialogs)).toEqual(['Untitled document.docx']);
  expect(await drive(page)).toEqual(before);
});

test('the documents screen downloads a document to this device, without the Save dialog', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html?env=app#/home');
  await page.evaluate(async () => { await puter.fs.write('Documents/Report.docx', new Blob(['not opened'])); });
  await page.reload();
  await page.evaluate(() => { window.__dialogs = []; puter.ui.showSaveFilePicker = (data, name) => { window.__dialogs.push(name); return new Promise(() => {}); }; });
  await page.locator('[data-path="Documents/Report.docx"] .file-menu-btn').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download' }).click()]);
  expect(download.suggestedFilename()).toBe('Report.docx');
  expect(await page.evaluate(() => window.__dialogs)).toEqual([]);
  await expect(page.getByText('Save asks where to keep a new document.')).toBeVisible();
});
