import { test, expect } from '@playwright/test';

// The version a save leaves is written once the save is done. The File view's version list and the Version History
// pane, opened in that moment, said "No earlier versions yet" (or missed the newest one) until opened again.
test('a version written after the File view or the Version History pane opened shows up in it', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  const text = page.getByRole('textbox', { name: 'Document text' });
  // Version writes take a while, as over a slow connection.
  await page.evaluate(() => window.__puterFaults.push({ op: 'write', path: '\\.versions/', delay: 1500, times: 1 }));
  await text.fill('First text');
  await text.press('ControlOrMeta+s');
  await expect(page.locator('.canvas-save-status')).toHaveAttribute('aria-label', 'Saved to Puter');
  await page.getByRole('button', { name: 'File', exact: true }).first().click();
  const versions = page.getByRole('dialog', { name: 'File' }).locator('#bs-versions');
  await expect(versions).toContainText('No earlier versions yet.');
  await expect(versions.getByRole('button', { name: 'Restore' })).toHaveCount(1);
  await page.keyboard.press('Escape');

  // The pane: a second version, written while it is open.
  await page.getByRole('button', { name: 'File', exact: true }).first().click();
  await versions.getByRole('button', { name: 'Open Version History' }).click();
  const pane = page.getByRole('complementary', { name: 'Version History pane' });
  await expect(pane.getByRole('listitem')).toHaveCount(1);
  await page.evaluate(() => { window.__docs.current.view.doc.lastVersionAt = 0; window.__puterFaults.push({ op: 'write', path: '\\.versions/', delay: 1500, times: 1 }); });
  await text.focus();
  await text.press('ControlOrMeta+End');
  await page.keyboard.type(' and more');
  await text.press('ControlOrMeta+s');
  await expect(page.locator('.canvas-save-status')).toHaveAttribute('aria-label', 'Saved to Puter');
  await expect(pane.getByRole('listitem')).toHaveCount(2);
  expect(errors).toEqual([]);
});
