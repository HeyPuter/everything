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

/** Share from the owner's page; returns the invitation link for editors. */
async function shareForEditing(page) {
  await page.getByRole('button', { name: 'Share', exact: true }).first().click();
  await page.getByRole('menuitem', { name: 'Invite People…' }).click();
  const dialog = page.getByRole('dialog', { name: /^Share/ });
  await dialog.getByRole('button', { name: 'Copy Link' }).click();
  const field = dialog.getByRole('textbox', { name: 'Invitation link' });
  await expect(field).toHaveValue(/collab-/, { timeout: 15000 });
  const link = await field.inputValue();
  await dialog.getByRole('button', { name: 'Done' }).click();
  return link;
}
async function stopSharing(page) {
  await page.getByRole('button', { name: 'Share', exact: true }).first().click();
  await page.getByRole('menuitem', { name: 'Manage Access…' }).click();
  const dialog = page.getByRole('dialog', { name: /^Share/ });
  await dialog.getByRole('button', { name: 'Stop Sharing' }).click();
  await page.getByRole('dialog', { name: 'Stop sharing?' }).getByRole('button', { name: 'Stop Sharing' }).click();
  await expect(dialog.locator('.sh-status')).toContainText('Sharing stopped');
  await dialog.getByRole('button', { name: 'Done' }).click();
}
const warnsOnUnload = page => page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; });

test('an editor keeps edits made after sharing stopped (tabs of one browser)', async ({ context }) => {
  const ann = await context.newPage();
  await ann.setViewportSize({ width: 1440, height: 900 });
  await ann.goto('/playground.html?name=Ann');
  await expect(ann.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await text(ann).fill('Shared draft.');
  const link = await shareForEditing(ann);
  const bob = await context.newPage();
  await bob.setViewportSize({ width: 1440, height: 900 });
  await bob.goto(link.replace('playground.html', 'playground.html?name=Bob'));
  await expect.poll(() => text(bob).evaluate(el => el.value)).toBe('Shared draft.');
  await stopSharing(ann);
  await expect(bob.locator('.cl-banner')).toContainText('your own copy');
  await text(bob).evaluate(el => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); el.dispatchEvent(new Event('select')); });
  await text(bob).pressSequentially(' Mine now.');
  await expect.poll(() => text(bob).evaluate(el => el.value)).toBe('Shared draft. Mine now.');
  expect(await warnsOnUnload(bob)).toBe(true);
});

test('an invited editor keeps edits made after the owner stopped sharing', async ({ browser }) => {
  test.setTimeout(120000);
  const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const owner = await ownerContext.newPage();
  await owner.goto('/mock.html?user=ada#/new');
  await expect(owner.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await text(owner).fill('Quarterly plan.');
  const link = await shareForEditing(owner);
  const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const guest = await guestContext.newPage();
  await guest.goto(link.replace('mock.html', 'mock.html?user=bob'));
  await expect.poll(() => text(guest).evaluate(el => el.value), { timeout: 15000 }).toBe('Quarterly plan.');
  await stopSharing(owner);
  await expect(guest.locator('.cl-banner')).toContainText('your own copy', { timeout: 15000 });
  await text(guest).evaluate(el => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); el.dispatchEvent(new Event('select')); });
  await text(guest).pressSequentially(' My notes.');
  // The copy is the guest's own now: its edits are saved like any new document's, and leaving before then is guarded.
  await expect.poll(() => guest.evaluate(() => { const d = window.__docs.current.view.doc; return d.dirty || !!d.path; })).toBe(true);
  await expect.poll(() => guest.evaluate(() => window.__docs.current.view.doc.path), { timeout: 15000 }).toMatch(/\.docx$/);
  await expect(status(guest)).toHaveAttribute('aria-label', 'Saved to Puter');
  expect(await guest.evaluate(() => window.__docs.current.view.doc.dirty)).toBe(false);
  expect(Object.keys(await drive(guest)).filter(p => /^Documents\/[^/]+\.docx$/.test(p))).toHaveLength(1);
  await ownerContext.close(); await guestContext.close();
});

test('File > Save: pressing Save As twice saves one copy and says so', async ({ page }) => {
  await openEditor(page);
  await text(page).fill('Original');
  await expect(status(page)).toHaveAttribute('aria-label', 'Saved to Puter');
  await page.evaluate(() => window.__puterFaults.push({ op: 'write', path: 'Copy\\.docx$', delay: 600, times: 1 }));
  await page.getByRole('button', { name: 'File', exact: true }).click();
  const view = page.getByRole('dialog', { name: 'File' });
  await view.getByRole('tab', { name: 'Save' }).click();
  await view.getByRole('textbox', { name: 'New file name' }).fill('Copy');
  const saveAs = view.getByRole('button', { name: 'Save As', exact: true });
  await saveAs.click();
  await saveAs.click({ force: true }).catch(() => {});
  await expect(view.getByRole('status').filter({ hasText: /Saved|exists|Saving/ })).toHaveText('Saved. You are now editing the copy.');
  await page.waitForTimeout(800);
  await expect(view.getByRole('status').filter({ hasText: /Saved|exists|Saving/ })).toHaveText('Saved. You are now editing the copy.');
  expect(await page.evaluate(() => window.__docs.current.view.doc.path)).toBe('Documents/Copy.docx');
});
