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

test('Save As in a shared document goes on in a copy the others do not see', async ({ browser }) => {
  test.setTimeout(120000);
  const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const owner = await ownerContext.newPage();
  await owner.goto('/mock.html?user=ada#/new');
  await expect(owner.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await text(owner).fill('Quarterly plan.');
  await expect(status(owner)).toHaveAttribute('aria-label', 'Saved to Puter');
  const link = await shareForEditing(owner);
  const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const guest = await guestContext.newPage();
  await guest.goto(link.replace('mock.html', 'mock.html?user=bob'));
  await expect.poll(() => text(guest).evaluate(el => el.value), { timeout: 15000 }).toBe('Quarterly plan.');
  await owner.getByRole('button', { name: 'File', exact: true }).click();
  const view = owner.getByRole('dialog', { name: 'File' });
  await view.getByRole('tab', { name: 'Save' }).click();
  await view.getByRole('textbox', { name: 'New file name' }).fill('Private copy');
  await view.getByRole('button', { name: 'Save As', exact: true }).click();
  await expect(view.getByRole('status')).toHaveText('Saved. You are now editing the copy.');
  await owner.keyboard.press('Escape');
  await expect(owner.locator('.cl-banner')).toContainText('your own copy now, which is not shared');
  await text(owner).evaluate(el => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); el.dispatchEvent(new Event('select')); });
  await text(owner).pressSequentially(' Private note.');
  await expect(status(owner)).toHaveAttribute('aria-label', 'Saved to Puter');
  // The copy's text stays out of the shared document.
  await guest.waitForTimeout(2000);
  expect(await text(guest).evaluate(el => el.value)).toBe('Quarterly plan.');
  await ownerContext.close(); await guestContext.close();
});

test('a guest leaving a shared document with changes the others have not received is asked first', async ({ browser }) => {
  test.setTimeout(120000);
  const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const owner = await ownerContext.newPage();
  await owner.goto('/mock.html?user=ada#/new');
  await expect(owner.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await text(owner).fill('Quarterly plan.');
  await expect(status(owner)).toHaveAttribute('aria-label', 'Saved to Puter');
  const link = await shareForEditing(owner);
  const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const guest = await guestContext.newPage();
  await guest.goto(link.replace('mock.html', 'mock.html?user=bob'));
  await expect.poll(() => text(guest).evaluate(el => el.value), { timeout: 15000 }).toBe('Quarterly plan.');
  await guestContext.setOffline(true);
  await text(guest).evaluate(el => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); el.dispatchEvent(new Event('select')); });
  await text(guest).pressSequentially(' Offline note.');
  await expect(guest.locator('.cl-chip')).toContainText('waiting', { timeout: 15000 });
  // The owner saves the file, so nothing is "unsaved" here; the changes are still in this tab only.
  expect(await warnsOnUnload(guest)).toBe(true);
  await guest.getByRole('button', { name: 'All Documents' }).click();
  const question = guest.getByRole('dialog', { name: 'Leave without saving?' });
  await expect(question).toContainText('have not reached the shared document yet');
  await question.getByRole('button', { name: 'Keep editing' }).click();
  expect(await guest.evaluate(() => window.__docs.current.kind)).toBe('editor');
  // Back online, leaving delivers them first and asks nothing.
  await guestContext.setOffline(false);
  await guest.getByRole('button', { name: 'All Documents' }).click();
  await expect(guest.getByRole('heading', { name: 'Your documents' })).toBeVisible({ timeout: 15000 });
  await expect.poll(() => text(owner).evaluate(el => el.value), { timeout: 15000 }).toBe('Quarterly plan. Offline note.');
  await ownerContext.close(); await guestContext.close();
});

test('an autosave refused because another window changed the file says so once, with Save a Copy', async ({ page }) => {
  await openEditor(page);
  await text(page).fill('Mine');
  await expect(status(page)).toHaveAttribute('aria-label', 'Saved to Puter');
  // Time stamps are whole seconds: the other window writes in a later one.
  await page.waitForTimeout(1100);
  await page.evaluate(async () => { const { path } = window.__docs.current.view.doc; await puter.fs.write(path, await puter.fs.read(path)); });
  await text(page).press('End');
  await page.keyboard.type(' and more');
  await expect(status(page)).toHaveAttribute('aria-label', 'Not saved');
  const notice = page.locator('.toast', { hasText: 'changed in another window' });
  await expect(notice).toHaveCount(1);
  // Further edits fail the same way without repeating it.
  await page.keyboard.type(' still');
  await page.waitForTimeout(2500);
  await expect(notice).toHaveCount(1);
  await notice.getByRole('button', { name: 'Save a Copy' }).click();
  const view = page.getByRole('dialog', { name: 'File' });
  await expect(view.getByRole('tab', { name: 'Save' })).toHaveAttribute('aria-selected', 'true');
  await view.getByRole('textbox', { name: 'New file name' }).fill('Mine kept');
  await view.getByRole('button', { name: 'Save As', exact: true }).click();
  await expect(view.getByRole('status')).toHaveText('Saved. You are now editing the copy.');
  await page.keyboard.press('Escape');
  await expect(status(page)).toHaveAttribute('aria-label', 'Saved to Puter');
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

test('autosave waits for an open IME composition instead of reporting a failed save', async ({ page }) => {
  await openEditor(page);
  await text(page).fill('Kept');
  await expect(status(page)).toHaveAttribute('aria-label', 'Saved to Puter');
  await text(page).press('End');
  await page.keyboard.type(' 안');
  // The last syllable stays in composition while the writer pauses, as a Korean IME keeps it.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: '녕', selectionStart: 1, selectionEnd: 1 });
  expect(await page.evaluate(() => !!window.__docs.current.view.engine.composition)).toBe(true);
  const seen = [];
  await page.exposeFunction('__status', s => seen.push(s));
  await page.evaluate(() => window.__docs.current.view.doc.addEventListener('status', e => window.__status(e.detail.status)));
  await page.waitForTimeout(3000);
  expect(seen).not.toContain('error');
  await expect(status(page)).toHaveAttribute('aria-label', 'Unsaved changes');
  await cdp.send('Input.insertText', { text: '녕' });
  await expect(status(page)).toHaveAttribute('aria-label', 'Saved to Puter', { timeout: 10000 });
  expect(seen).not.toContain('error');
  expect(await page.evaluate(() => window.__docs.current.view.engine.model.text)).toBe('Kept 안녕');
});

test('leaving while a save hangs asks instead of waiting forever', async ({ page }) => {
  test.setTimeout(60000);
  await openEditor(page);
  await text(page).fill('Kept');
  await expect(status(page)).toHaveAttribute('aria-label', 'Saved to Puter');
  await page.evaluate(() => window.__puterFaults.push({ op: 'write', path: '^Documents/[^/]+\\.docx$', delay: 120000, times: 1 }));
  await text(page).press('End'); await page.keyboard.type(' more');
  await expect(status(page)).toHaveAttribute('aria-label', 'Saving…');
  await page.evaluate(() => { location.hash = '#/home'; });
  const dialog = page.getByRole('dialog', { name: 'Leave without saving?' });
  await expect(dialog).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.toast-root')).toContainText('Saving is taking longer than usual');
  await dialog.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page).toHaveURL(/#\/edit\//);
  await expect(text(page)).toHaveValue('Kept more');
});

test('signing out with a document that cannot be saved says why it did not sign out', async ({ page }) => {
  await openEditor(page);
  // An imported file the editor cannot open is kept for download, never saved.
  await page.locator('input[aria-label="Open DOCX file"]').setInputFiles({ name: 'Broken.docx', mimeType: 'application/octet-stream', buffer: Buffer.from('not a zip file') });
  await expect(page.locator('.canvas-message')).toContainText(/./);
  await expect(page.getByRole('button', { name: 'Download original' })).toBeVisible();
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.getByRole('dialog', { name: 'Sign out?' }).getByRole('button', { name: 'Sign out' }).click();
  await expect(page.locator('.toast-root')).toContainText('still signed in');
  expect(await page.evaluate(() => window.__docs.session.signedIn)).toBe(true);
});

test('a starred document renamed in the editor stays starred', async ({ page }) => {
  await openEditor(page);
  await text(page).fill('Starred text');
  await expect(status(page)).toHaveAttribute('aria-label', 'Saved to Puter');
  await page.evaluate(() => { location.hash = '#/home'; });
  const row = page.locator('.file-row', { hasText: 'Untitled document' });
  await row.getByRole('button', { name: /^Star / }).click();
  await expect(row).toHaveClass(/is-starred/);
  await row.locator('.file-main').click();
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  const title = page.getByRole('textbox', { name: 'Document name' });
  await title.fill('Renamed plan');
  await title.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__docs.current.view.doc.path)).toBe('Documents/Renamed plan.docx');
  await page.evaluate(() => { location.hash = '#/home'; });
  await expect(page.locator('.file-row', { hasText: 'Renamed plan' })).toHaveClass(/is-starred/);
});

test('a name typed just before going back to the documents is kept', async ({ page }) => {
  await openEditor(page);
  await text(page).fill('Plan text');
  await expect(status(page)).toHaveAttribute('aria-label', 'Saved to Puter');
  // Checking that the new name is free takes a moment.
  await page.evaluate(() => window.__puterFaults.push({ op: 'stat', path: '^Documents/Final plan\\.docx$', delay: 800, times: 1 }));
  const title = page.getByRole('textbox', { name: 'Document name' });
  await title.fill('Final plan');
  await title.press('Enter');
  await page.evaluate(() => { location.hash = '#/home'; });
  await expect(page.locator('.file-row', { hasText: 'Final plan' })).toBeVisible();
  await expect(page.locator('.file-row', { hasText: 'Untitled document' })).toHaveCount(0);
  await expect(page.locator('.toast-root')).not.toContainText('cancelled');
});

test('Open Recent says when the documents could not be listed', async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => window.__puterFaults.push({ op: 'readdir', path: '^Documents$', message: 'Network error', times: 1 }));
  await page.locator('.ed-menubar').getByRole('menuitem', { name: 'File', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Open Recent', exact: true }).click();
  await expect(page.locator('.menu-note')).toHaveText('Could not load recent documents. Check your connection and try again.');
});

test('hiding the page writes edits typed during a save as soon as that save ends', async ({ page }) => {
  await openEditor(page);
  await text(page).fill('Draft');
  await expect(status(page)).toHaveAttribute('aria-label', 'Saved to Puter');
  // A slow write: the pause before the next autosave grows with it, to several seconds.
  await page.evaluate(() => window.__puterFaults.push({ op: 'write', path: '^Documents/[^/]+\\.docx$', delay: 1500, times: 1 }));
  await text(page).press('End'); await page.keyboard.type(' one');
  await expect(status(page)).toHaveAttribute('aria-label', 'Saving…');
  await page.keyboard.type(' two');
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    delete document.visibilityState;
  });
  await expect.poll(() => page.evaluate(() => window.__docs.current.view.doc.dirty), { timeout: 3000 }).toBe(false);
});

test('a new document saved under a free name shows that name', async ({ page }) => {
  await openEditor(page);
  await text(page).fill('First');
  await expect(status(page)).toHaveAttribute('aria-label', 'Saved to Puter');
  await page.evaluate(() => { location.hash = '#/home'; });
  await page.getByRole('button', { name: 'New document' }).first().click();
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await text(page).fill('Second');
  await expect.poll(() => page.evaluate(() => window.__docs.current.view.doc.path)).toBe('Documents/Untitled document 2.docx');
  await expect(page.getByRole('textbox', { name: 'Document name' })).toHaveValue('Untitled document 2');
  await expect(page).toHaveTitle('Untitled document 2 — Documents');
});
