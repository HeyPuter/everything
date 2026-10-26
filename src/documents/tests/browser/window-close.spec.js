import { test, expect } from '@playwright/test';

/**
 * Inside the Puter desktop (the mock's ?env=app) a new document waits for a first Save to ask where it goes, so
 * the status says it is not saved yet, and the window's close button asks before a never-saved document goes
 * with it. The mock records the desktop's close handler as window.__closeWindow and counts exits in
 * window.__exits; its Save dialog saves under ~/Desktop, or cancels when window.__puterSaveAs is null.
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

test('a new document says it is not saved yet, and its status saves it', async ({ page }) => {
  await openEditor(page);
  await text(page).fill('Draft');
  await expect(status(page)).toHaveAttribute('aria-label', 'Not saved yet');
  await expect(status(page)).toHaveAttribute('title', /AutoSave starts then/);
  await status(page).click();
  await expect(status(page)).toHaveAttribute('aria-label', 'Saved to Puter');
  expect(await docPath(page)).toBe('~/Desktop/Untitled document.docx');
});

test.describe('the Puter window\'s close button', () => {
  const closeWindow = page => page.evaluate(() => { window.__closeWindow(); });
  const exits = page => page.evaluate(() => window.__exits || 0);
  const question = page => page.getByRole('dialog', { name: 'Save before closing?' });

  test('pressed while the question about leaving is up, it waits for that answer instead of asking again', async ({ page }) => {
    await openEditor(page);
    await text(page).fill('Saved');
    await text(page).press('ControlOrMeta+s');
    await expect(status(page)).toHaveAttribute('aria-label', 'Saved to Puter');
    await page.evaluate(() => window.__puterFaults.push({ op: 'write', message: 'The cloud is unreachable' }));
    await page.keyboard.type(' and more');
    await expect(status(page)).toHaveAttribute('aria-label', 'Not saved');
    await page.getByRole('button', { name: 'All Documents' }).click();
    const leaving = page.getByRole('dialog', { name: 'Leave without saving?' });
    await expect(leaving).toHaveCount(1);
    await closeWindow(page);
    await expect(page.locator('.toast-root')).toContainText('Answer the question about the open document first');
    await expect(leaving).toHaveCount(1);
    expect(await exits(page)).toBe(0);
    await leaving.getByRole('button', { name: 'Keep editing' }).click();
    await expect(leaving).toHaveCount(0);
  });

  test('closes at once when nothing is waiting to be saved', async ({ page }) => {
    await openEditor(page);
    await closeWindow(page);
    await expect.poll(() => exits(page)).toBe(1);
    await expect(question(page)).toHaveCount(0);
  });

  test('writes a saved document\'s edits, then closes without asking', async ({ page }) => {
    await openEditor(page);
    await text(page).fill('Saved');
    await text(page).press('ControlOrMeta+s');
    await expect(status(page)).toHaveAttribute('aria-label', 'Saved to Puter');
    await page.evaluate(() => { window.__writes = []; const write = puter.fs.write; puter.fs.write = function (p, ...rest) { window.__writes.push(p); return write.call(this, p, ...rest); }; });
    await page.keyboard.type(' and closed');
    await closeWindow(page);
    await expect.poll(() => exits(page)).toBe(1);
    expect(await page.evaluate(() => window.__writes.filter(p => !p.includes('/.versions')))).toEqual(['~/Desktop/Untitled document.docx']);
    await expect(question(page)).toHaveCount(0);
  });

  test('asks about a never-saved document: Cancel stays, Close without saving closes', async ({ page }) => {
    await openEditor(page);
    await text(page).fill('Draft');
    await closeWindow(page);
    await expect(question(page)).toBeVisible();
    await question(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(question(page)).toHaveCount(0);
    expect(await exits(page)).toBe(0);
    await expect(text(page)).toHaveValue('Draft');
    await closeWindow(page);
    await question(page).getByRole('button', { name: 'Close without saving' }).click();
    await expect.poll(() => exits(page)).toBe(1);
    expect(await drive(page)).toEqual([]);
    expect(await page.evaluate(() => window.__dialogs)).toEqual([]);
  });

  test('Save… asks where and closes once saved; a cancelled Save dialog keeps the window open', async ({ page }) => {
    await openEditor(page);
    await text(page).fill('Draft');
    await page.evaluate(() => { window.__puterSaveAs = null; });
    await closeWindow(page);
    await question(page).getByRole('button', { name: 'Save…' }).click();
    await expect.poll(() => page.evaluate(() => window.__dialogs.length)).toBe(1);
    await page.waitForTimeout(500);
    expect(await exits(page)).toBe(0);
    await expect(status(page)).toHaveAttribute('aria-label', 'Not saved yet');
    await page.evaluate(() => { window.__puterSaveAs = 'Closing.docx'; });
    await closeWindow(page);
    await question(page).getByRole('button', { name: 'Save…' }).click();
    await expect.poll(() => exits(page)).toBe(1);
    expect(await drive(page)).toEqual(['~/Desktop/Closing.docx']);
  });

  test('a Save dialog closed with Esc keeps the window open, and the close button still works', async ({ page }) => {
    await openEditor(page);
    await text(page).fill('Draft');
    await page.evaluate(() => { window.__puterSaveAs = 'dismiss'; });
    await closeWindow(page);
    await question(page).getByRole('button', { name: 'Save…' }).click();
    await expect.poll(() => page.evaluate(() => window.__dialogs.length)).toBe(1);
    // Esc sends no answer; the desktop hands the window the focus back, and the close is off.
    await expect.poll(() => page.evaluate(() => window.__docs.current.view.doc.choosingPlace)).toBe(false);
    expect(await exits(page)).toBe(0);
    await expect(status(page)).toHaveAttribute('aria-label', 'Not saved yet');
    // Pressed again, the close button asks again rather than waiting on the dialog that has gone.
    await closeWindow(page);
    await expect(question(page)).toBeVisible();
    await question(page).getByRole('button', { name: 'Close without saving' }).click();
    await expect.poll(() => exits(page)).toBe(1);
  });
});
