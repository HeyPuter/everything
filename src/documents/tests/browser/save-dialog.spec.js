import { test, expect } from '@playwright/test';

/**
 * Inside the Puter desktop (the mock's ?env=app) a new document is saved where the user chooses, with Puter's
 * Save dialog, and only when the user asks. The mock's dialog saves under ~/Desktop, or cancels when a test sets
 * window.__puterSaveAs to null.
 */

const text = page => page.getByRole('textbox', { name: 'Document text' });
const status = page => page.locator('.canvas-save-status');
// The documents on the drive; their version history, kept in the app folder, is not one of them.
const drive = page => page.evaluate(() => Object.keys(JSON.parse(sessionStorage.getItem('documents-mock-state') || '{"fs":{}}').fs).filter(p => !p.includes('/.versions')));
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

test('a name typed without .docx in the Save dialog gets it, and AutoSave goes on there', async ({ page }) => {
  await openEditor(page);
  await text(page).fill('Notes');
  await page.evaluate(() => { window.__puterSaveAs = 'Notes'; });
  await text(page).press('ControlOrMeta+s');
  await expect(status(page)).toHaveAttribute('aria-label', 'Saved to Puter');
  expect(await docPath(page)).toBe('~/Desktop/Notes.docx');
  await page.keyboard.type(' and more');
  await expect(status(page)).toHaveAttribute('aria-label', 'Unsaved changes');
  await expect(status(page)).toHaveAttribute('aria-label', 'Saved to Puter');
  expect(await drive(page)).toEqual(['~/Desktop/Notes.docx']);
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

test('a document saved elsewhere through the Save dialog keeps a version history', async ({ page }) => {
  await openEditor(page);
  await text(page).fill('First version.');
  await text(page).press('ControlOrMeta+s');
  await expect(status(page)).toHaveAttribute('aria-label', 'Saved to Puter');
  expect(await docPath(page)).toBe('~/Desktop/Untitled document.docx');
  await page.locator('.ed-menubar').getByRole('menuitem', { name: 'File', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Browse Version History', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Version History pane' });
  // The first save left a snapshot, as it does for a document in the app folder.
  await expect(pane.getByRole('listitem')).toHaveCount(1);
  await pane.getByRole('button', { name: 'Save a Version Now' }).click();
  await page.getByRole('dialog', { name: 'Save a version' }).getByRole('textbox').fill('Clean draft');
  await page.getByRole('dialog', { name: 'Save a version' }).getByRole('button', { name: 'Save Version' }).click();
  await expect(pane.getByRole('listitem').first()).toContainText('Clean draft');
  await expect(page.locator('.toast-root')).not.toContainText('could not be saved');
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

test('sharing a template with edits saves it as a new .docx first, and shares that', async ({ page }) => {
  test.setTimeout(60000);
  await openEditor(page);
  // A template on the drive, opened from there: its edits go to a new .docx at the first Save.
  await text(page).fill('Dear reader,');
  await page.evaluate(async () => {
    const doc = window.__docs.current.view.doc;
    await puter.fs.write('~/Desktop/Letter.dotx', await doc.exporter());
    doc.discardEdits();
  });
  await page.goto('about:blank');
  await openEditor(page, '#/edit/~%2FDesktop%2FLetter.dotx');
  await text(page).press('End');
  await page.keyboard.type(' hello');
  await expect(status(page)).toHaveAttribute('aria-label', 'Not saved yet');
  await page.evaluate(() => { window.__puterSaveAs = null; });
  await page.getByRole('button', { name: 'Share', exact: true }).first().click();
  await page.getByRole('menuitem', { name: 'Invite People…' }).click();
  const dialog = page.getByRole('dialog', { name: /^Share/ });
  await dialog.getByRole('button', { name: 'Copy Link' }).click();
  // Cancelled, nothing is shared: the template is not the file the edits go to.
  await expect(dialog).toContainText('Save the document before sharing it.');
  expect(await page.evaluate(() => window.__dialogs)).toEqual(['Letter.docx']);
  expect(await docPath(page)).toBe('~/Desktop/Letter.dotx');
  await page.evaluate(() => { window.__puterSaveAs = 'Letter.docx'; });
  await dialog.getByRole('button', { name: 'Copy Link' }).click();
  await expect(dialog.getByRole('textbox', { name: 'Invitation link' })).toHaveValue(/collab-/, { timeout: 15000 });
  expect(await docPath(page)).toBe('~/Desktop/Letter.docx');
});

test('publishing a template with edits saves it as a new .docx first, and publishes that', async ({ page }) => {
  await openEditor(page);
  await text(page).fill('Notice');
  await page.evaluate(async () => {
    const doc = window.__docs.current.view.doc;
    await puter.fs.write('~/Desktop/Notice.dotx', await doc.exporter());
    doc.discardEdits();
  });
  await page.goto('about:blank');
  await openEditor(page, '#/edit/~%2FDesktop%2FNotice.dotx');
  await text(page).press('End');
  await page.keyboard.type(' board');
  await page.evaluate(() => { window.__puterSaveAs = null; });
  await page.getByRole('button', { name: 'File', exact: true }).click();
  const view = page.getByRole('dialog', { name: 'File' });
  await view.getByRole('tab', { name: 'Share' }).click();
  await view.getByRole('button', { name: 'Publish to the Web' }).click();
  await expect(view.locator('.bs-share-note')).toHaveText('Save the document first.');
  expect(await page.evaluate(() => Object.keys(puter.hosting._sites))).toEqual([]);
  await page.evaluate(() => { window.__puterSaveAs = 'Notice.docx'; });
  await view.getByRole('button', { name: 'Publish to the Web' }).click();
  await expect(view.getByRole('button', { name: 'Stop Publishing' })).toBeVisible();
  expect(await docPath(page)).toBe('~/Desktop/Notice.docx');
});

test('leaving a template with edits says only the changes are unsaved, not the file', async ({ page }) => {
  await openEditor(page);
  await text(page).fill('Memo');
  await page.evaluate(async () => {
    const doc = window.__docs.current.view.doc;
    await puter.fs.write('~/Desktop/Memo.dotx', await doc.exporter());
    doc.discardEdits();
  });
  await page.goto('about:blank');
  await openEditor(page, '#/edit/~%2FDesktop%2FMemo.dotx');
  await text(page).press('End');
  await page.keyboard.type(' text');
  await page.evaluate(() => { window.__puterSaveAs = null; location.hash = '#/home'; });
  const dialog = page.getByRole('dialog', { name: 'Leave without saving?' });
  await expect(dialog).toContainText('Your changes to “Memo.dotx” have not been saved yet.');
  await dialog.getByRole('button', { name: 'Leave without saving' }).click();
  await expect(page.getByRole('heading', { name: 'Your documents' })).toBeVisible();
  expect(await drive(page)).toEqual(['~/Desktop/Memo.dotx']);
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
