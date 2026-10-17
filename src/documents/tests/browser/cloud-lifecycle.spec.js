import { test, expect } from '@playwright/test';

const text = page => page.getByRole('textbox', { name: 'Document text' });
const status = page => page.locator('.canvas-save-status');
/** The mock drive's files: path -> size. */
const drive = page => page.evaluate(() => Object.fromEntries(Object.entries(JSON.parse(sessionStorage.getItem('documents-mock-state') || '{"fs":{}}').fs).map(([k, f]) => [k, f.size])));

async function openEditor(page, hash = '#/new') {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/mock.html${hash}`);
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
}

test('AutoSave off: hiding the page, reconnecting or signing in does not write the file', async ({ page }) => {
  await openEditor(page);
  await text(page).fill('Kept');
  await expect(status(page)).toHaveAttribute('aria-label', 'Saved to Puter');
  const path = await page.evaluate(() => window.__docs.current.view.doc.path);
  const writes = () => page.evaluate(p => window.__writes.filter(w => w === p).length, path.replace(/^\/+/, ''));
  await page.evaluate(() => { window.__writes = []; const write = puter.fs.write; puter.fs.write = function (p, ...rest) { window.__writes.push(String(p).replace(/^\/+/, '')); return write.call(this, p, ...rest); }; });
  await page.locator('label.ed-autosave').click();
  await expect(page.getByRole('switch', { name: 'AutoSave' })).not.toBeChecked();
  await text(page).press('End'); await page.keyboard.type(' experiment');
  await expect(status(page)).toHaveAttribute('aria-label', 'Unsaved changes');
  // The tab goes to the background, the page is hidden, the connection comes back.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('online'));
    delete document.visibilityState;
  });
  await page.waitForTimeout(1500);
  expect(await writes()).toBe(0);
  await expect(status(page)).toHaveAttribute('aria-label', 'Unsaved changes');
  // Save still writes.
  await text(page).press('ControlOrMeta+s');
  await expect(status(page)).toHaveAttribute('aria-label', 'Saved to Puter');
  expect(await writes()).toBe(1);
  await page.locator('label.ed-autosave').click();
});

test('File > Info: a version that cannot be saved says so', async ({ page }) => {
  await openEditor(page);
  await text(page).fill('Versioned');
  await expect(status(page)).toHaveAttribute('aria-label', 'Saved to Puter');
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.evaluate(() => window.__puterFaults.push({ op: 'write', path: '\\.versions/', message: 'The cloud is unreachable', times: 5 }));
  await page.getByRole('button', { name: 'File', exact: true }).click();
  const view = page.getByRole('dialog', { name: 'File' });
  await view.getByRole('tab', { name: 'Info' }).click();
  await view.getByRole('button', { name: 'Save a Version Now' }).click();
  await expect(page.locator('.toast-root')).toContainText('The cloud is unreachable');
  await expect(view.getByRole('button', { name: 'Save a Version Now' })).toBeEnabled();
  expect(errors).toEqual([]);
});
