import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { PDFDocument, PDFHexString, PDFName } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import {
  PasswordError,
  aesCbcEncrypt,
  protectPdf,
  toHex,
  unlockPdf,
} from '../../src/core/security.js';
import { createSelfSignedId, signPdf } from '../../src/core/digital-signature.js';

const PUTER_MOCK = `window.puter = { env: 'web', auth: { isSignedIn: () => true, getUser: async () => ({username:'test-user'}), signIn: async () => {}, signOut: async () => {} }, fs: { readdir: async () => [], write: async () => ({}) }, ui: { onLaunchedWithItems: () => {}, onItemsOpened: () => {} } };`;
async function mockPuter(page) {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
  );
}
const fixture = (name) => readFile(new URL(`../fixtures/security/${name}.pdf`, import.meta.url));
/** Choose a file from the library's open button. */
async function chooseFile(page, buffer, name = 'statement.pdf') {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (await chooser).setFiles({ name, mimeType: 'application/pdf', buffer });
}
async function openPdf(page, doc) {
  await chooseFile(page, Buffer.from(await doc.save()), 'test.pdf');
  await expect(page.locator('.page-caption')).toHaveText(`Page 1 of ${doc.getPageCount()}`);
}
/** Choose a menu item by name from the menu bar, or from the folded phone menu. */
async function menu(page, name) {
  const bar = page.getByRole('menubar', { name: 'PDF menus' });
  const item = page.getByRole('menu').getByRole('menuitem', { name, exact: true });
  if (await bar.isVisible()) {
    for (const title of ['File', 'Edit', 'View', 'Page', 'Insert']) {
      await bar.getByRole('menuitem', { name: title, exact: true }).click();
      if (await item.count()) return item.click();
      await page.keyboard.press('Escape');
    }
  } else {
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    if (await item.count()) return item.click();
    for (const section of ['Edit', 'View', 'Page', 'Insert']) {
      await page.getByRole('menu').getByRole('menuitem', { name: section, exact: true }).click();
      if (await item.count()) return item.click();
      await page.keyboard.press('Escape');
    }
  }
  throw new Error(`No menu item named ${name}`);
}
async function downloaded(page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  return new Uint8Array(await readFile(await (await pending).path()));
}
const passwordDialog = (page) => page.getByRole('dialog', { name: 'Password required' });
const badge = (page) => page.getByRole('button', { name: 'Protected', exact: true });

test('asks for the password of a protected PDF, rejects wrong ones, and keeps the protection on download', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await chooseFile(page, await fixture('aes-256'));
  const dialog = passwordDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('statement.pdf is password protected');
  const accessibility = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await dialog.getByLabel('Password', { exact: true }).fill('nope');
  await dialog.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('That password is not right. Try again.');
  await expect(dialog.getByLabel('Password', { exact: true })).toBeFocused();
  await dialog.getByLabel('Show password').check();
  await expect(dialog.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'text');
  await dialog.getByLabel('Password', { exact: true }).fill('user');
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
  await expect(page.locator('.save-status')).toHaveText('Local file');
  await expect(badge(page)).toBeVisible();
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await expect(
    page.getByRole('region', { name: 'PDF page view' }).getByText('Secret report'),
  ).toBeVisible();
  const bytes = await downloaded(page);
  await expect(page.locator('.save-status')).toHaveText('Downloaded');
  await expect(PDFDocument.load(bytes)).rejects.toThrow(/encrypted/i);
  const unlocked = await unlockPdf(bytes, 'user');
  expect(unlocked.owner).toBe(false);
  expect((await PDFDocument.load(unlocked.bytes)).getPageCount()).toBe(2);
  // The copy keeps the file's own protection, so its owner password still works too.
  expect((await unlockPdf(bytes, 'owner')).owner).toBe(true);
  await expect(unlockPdf(bytes, 'nope')).rejects.toBeInstanceOf(PasswordError);
});

test('opens a PDF that only restricts permissions without a prompt and keeps them on download', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await chooseFile(page, await fixture('owner-only'));
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
  await expect(passwordDialog(page)).toHaveCount(0);
  await expect(badge(page)).toBeVisible();
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  // The badge opens the protection, showing the restrictions the file carries.
  await badge(page).click();
  const dialog = page.getByRole('dialog', { name: 'Permissions password required' });
  await expect(dialog.getByLabel('Document permissions')).toContainText('PrintingNot allowed');
  await expect(dialog.getByLabel('Document permissions')).toContainText('Editing contentAllowed');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  const bytes = await downloaded(page);
  await expect(PDFDocument.load(bytes)).rejects.toThrow(/encrypted/i);
  const opened = await unlockPdf(bytes, '');
  expect(opened.owner).toBe(false);
  const doc = await PDFDocument.load(opened.bytes);
  expect(doc.getPageCount()).toBe(2);
  expect(doc.getTitle()).toBe('Secret Title');
  expect((await unlockPdf(bytes, 'owner')).owner).toBe(true);
});

test('cancelling the password prompt keeps the PDF that was open', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/');
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  const chooser = page.waitForEvent('filechooser');
  await menu(page, 'Open…');
  await (
    await chooser
  ).setFiles({
    name: 'locked.pdf',
    mimeType: 'application/pdf',
    buffer: await fixture('rc4-128'),
  });
  const dialog = passwordDialog(page);
  await expect(dialog).toContainText('locked.pdf is password protected');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await expect(page.locator('.document-name')).toHaveText('Untitled');
});

async function holdFirstPasswordHash(page) {
  await page.evaluate(() => {
    const digest = SubtleCrypto.prototype.digest;
    let first = true;
    window.passwordHashes = 0;
    SubtleCrypto.prototype.digest = async function (...args) {
      const result = await digest.apply(this, args);
      window.passwordHashes++;
      if (first) {
        first = false;
        await new Promise((resolve) => {
          window.releasePasswordHash = resolve;
        });
      }
      return result;
    };
  });
}

for (const view of ['library', 'editor'])
  test(`a password check cancelled from the ${view} cannot report its error inside a later dialog`, async ({
    page,
  }) => {
    await mockPuter(page);
    await page.goto(view === 'library' ? '/#library' : '/');
    if (view === 'library')
      await expect(page.getByRole('button', { name: /Open a PDF/ })).toBeVisible();
    else await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('ControlOrMeta+o');
    await (
      await chooser
    ).setFiles({
      name: 'locked.pdf',
      mimeType: 'application/pdf',
      buffer: await fixture('aes-256-r5'),
    });
    const dialog = passwordDialog(page);
    await expect(dialog).toBeVisible();
    await holdFirstPasswordHash(page);
    await dialog.getByLabel('Password', { exact: true }).fill('wrong');
    await dialog.getByRole('button', { name: 'Open', exact: true }).click();
    await expect.poll(() => page.evaluate(() => !!window.releasePasswordHash)).toBe(true);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await page.evaluate(() => window.releasePasswordHash());
    // Revision 5 checks a wrong password with exactly two SHA digests (owner, then user).
    await expect.poll(() => page.evaluate(() => window.passwordHashes)).toBe(2);
    await page.evaluate(() => new Promise(requestAnimationFrame));
    expect(await settings.getByRole('alert').isVisible()).toBe(false);
    await expect(settings.getByLabel('Appearance')).toBeFocused();
  });

for (const [password, label] of [
  ['user', 'Password to open'],
  ['owner', 'Permissions password'],
])
  test(`protection remembers the submitted ${password} password when the field changes during verification`, async ({
    page,
  }) => {
    await mockPuter(page);
    await page.goto('/#library');
    await chooseFile(page, await fixture('aes-256-r5'));
    const dialog = passwordDialog(page);
    await expect(dialog).toBeVisible();
    await holdFirstPasswordHash(page);
    await dialog.getByLabel('Password', { exact: true }).fill(password);
    await dialog.getByRole('button', { name: 'Open', exact: true }).click();
    await expect.poll(() => page.evaluate(() => !!window.releasePasswordHash)).toBe(true);
    await dialog.getByLabel('Password', { exact: true }).fill('unfinished replacement');
    await page.evaluate(() => window.releasePasswordHash());
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
    await badge(page).click();
    if (password === 'user') {
      const ownerDialog = page.getByRole('dialog', { name: 'Permissions password required' });
      await ownerDialog.getByLabel('Permissions password').fill('owner');
      await ownerDialog.getByRole('button', { name: 'Unlock', exact: true }).click();
      await expect(ownerDialog).toBeHidden();
      await badge(page).click();
    }
    const protection = page.getByRole('dialog', { name: 'Change password' });
    await expect(protection.getByLabel(label, { exact: true })).toHaveValue(password);
    await protection.getByRole('button', { name: 'Cancel', exact: true }).click();
    const bytes = await downloaded(page);
    expect((await unlockPdf(bytes, 'user')).owner).toBe(false);
    expect((await unlockPdf(bytes, 'owner')).owner).toBe(true);
  });

for (const name of ['aes-256', 'aes-256-r5', 'rc4-128'])
  test(`changing the restrictions of a ${name} PDF opened with its permissions password keeps its open password`, async ({
    page,
  }) => {
    await mockPuter(page);
    await page.goto('/#library');
    await chooseFile(page, await fixture(name));
    const dialog = passwordDialog(page);
    await dialog.getByLabel('Password', { exact: true }).fill('owner');
    await dialog.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
    await badge(page).click();
    const change = page.getByRole('dialog', { name: 'Change password' });
    await expect(change.getByLabel('Permissions password', { exact: true })).toHaveValue('owner');
    await change.getByLabel('Print', { exact: true }).uncheck();
    await change.getByRole('button', { name: 'Update', exact: true }).click();
    await expect(change).toBeHidden();
    const bytes = await downloaded(page);
    // The reader password nobody typed here still guards the file.
    await expect(unlockPdf(bytes, '')).rejects.toBeInstanceOf(PasswordError);
    const reader = await unlockPdf(bytes, 'user');
    expect(reader.owner).toBe(false);
    expect(reader.encryption.security.P & 0x4).toBe(0);
    expect((await unlockPdf(bytes, 'owner')).owner).toBe(true);
  });

test('changing the password keeps permissions the dialog does not list', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  // Printing at low resolution only, and filling in forms without commenting, as Acrobat offers.
  const doc = await PDFDocument.create();
  doc.addPage([300, 300]);
  const plain = await doc.save();
  const opened = await unlockPdf(
    await protectPdf(plain, { open: 'user', permissions: 'owner' }),
    'owner',
  );
  const { fileKey, dict } = opened.encryption;
  const P = (-4 & ~0x800 & ~0x20) | 0;
  const block = new Uint8Array(16);
  new DataView(block.buffer).setInt32(0, P, true);
  block.set([0xff, 0xff, 0xff, 0xff, 0x54, 0x61, 0x64, 0x62], 4);
  dict.set(PDFName.of('P'), dict.context.obj(P));
  dict.set(
    PDFName.of('Perms'),
    PDFHexString.of(toHex(aesCbcEncrypt(fileKey, new Uint8Array(16), block))),
  );
  opened.encryption.security.P = P;
  const restricted = await protectPdf(plain, { original: opened.encryption });
  await chooseFile(page, Buffer.from(restricted));
  const dialog = passwordDialog(page);
  await dialog.getByLabel('Password', { exact: true }).fill('owner');
  await dialog.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await badge(page).click();
  const change = page.getByRole('dialog', { name: 'Change password' });
  await change.getByLabel('Password to open', { exact: true }).fill('reader');
  await change.getByLabel('Confirm password', { exact: true }).fill('reader');
  await change.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(change).toBeHidden();
  const { owner, encryption } = await unlockPdf(await downloaded(page), 'reader');
  expect(owner).toBe(false);
  // Printing stays at low resolution, and forms can still be filled in.
  expect(encryption.security.P & 0x4).toBe(0x4);
  expect(encryption.security.P & 0x800).toBe(0);
  expect(encryption.security.P & 0x20).toBe(0);
  expect(encryption.security.P & 0x100).toBe(0x100);
});

test('the Signatures panel reads the reason and field of a signed PDF opened with its password', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([300, 300]);
  const id = await createSelfSignedId({ name: 'Ada Lovelace' });
  const signed = await signPdf(await doc.save(), id, {
    fieldName: 'Approval',
    reason: 'Approved by finance',
    rect: { x: 20, y: 20, width: 200, height: 50 },
  });
  // Its strings are encrypted, the signature value is not.
  const locked = await protectPdf(signed, { open: 'user', permissions: 'owner' });
  await chooseFile(page, Buffer.from(locked));
  const dialog = passwordDialog(page);
  await dialog.getByLabel('Password', { exact: true }).fill('user');
  await dialog.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await page.getByRole('tab', { name: 'Signatures' }).click();
  const panel = page.getByRole('tabpanel', { name: 'Signatures' });
  await expect(panel.locator('dd')).toContainText(['Approved by finance', 'Approval']);
});

test('protects a PDF with an open password, marks it unsaved, and removes the password again', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([300, 300]).drawText('Plain page', { x: 30, y: 200, size: 18 });
  await openPdf(page, doc);
  await menu(page, 'Protect with password…');
  const dialog = page.getByRole('dialog', { name: 'Protect with password' });
  await expect(dialog.getByLabel('Password to open')).toBeFocused();
  await expect(dialog.getByLabel('Permissions password')).toBeHidden();
  const accessibility = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await dialog.getByRole('button', { name: 'Protect', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Enter a password to open the PDF');
  await dialog.getByLabel('Password to open').fill('secret');
  await dialog.getByLabel('Confirm password').fill('secrte');
  await dialog.getByRole('button', { name: 'Protect', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('The passwords do not match.');
  await expect(dialog.getByLabel('Confirm password')).toBeFocused();
  await dialog.getByLabel('Confirm password').fill('secret');
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(page.locator('#toast')).toHaveText(
    'The password is applied when you download or save.',
  );
  await expect(badge(page)).toBeVisible();
  await expect(page.locator('.save-status')).toHaveText('Unsaved changes');
  await expect(page).toHaveTitle(/^\* /);
  const bytes = await downloaded(page);
  await expect(page.locator('.save-status')).toHaveText('Downloaded');
  await expect(page.locator('#toast')).toHaveText('Password-protected PDF downloaded.');
  await expect(PDFDocument.load(bytes)).rejects.toThrow(/encrypted/i);
  await expect(unlockPdf(bytes, '')).rejects.toBeInstanceOf(PasswordError);
  const unlocked = await PDFDocument.load((await unlockPdf(bytes, 'secret')).bytes);
  expect(unlocked.getPageCount()).toBe(1);
  // The badge reopens the dialog with the password kept, and can remove it.
  await badge(page).click();
  const change = page.getByRole('dialog', { name: 'Change password' });
  await expect(change.getByLabel('Password to open')).toHaveValue('secret');
  await change.getByRole('button', { name: 'Remove password', exact: true }).click();
  await expect(change).toBeHidden();
  await expect(badge(page)).toBeHidden();
  await expect(page.locator('.save-status')).toHaveText('Unsaved changes');
  const plain = await PDFDocument.load(await downloaded(page));
  expect(plain.getPageCount()).toBe(1);
  await expect(page.locator('.save-status')).toHaveText('Downloaded');
  await menu(page, 'Protect with password…');
  await expect(page.getByRole('dialog', { name: 'Protect with password' })).toBeVisible();
});

test('restricts printing with a permissions password and no open password', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([300, 300]);
  await openPdf(page, doc);
  await menu(page, 'Protect with password…');
  const dialog = page.getByRole('dialog', { name: 'Protect with password' });
  await dialog.getByLabel('Restrict printing, copying, or editing').check();
  await expect(dialog.getByLabel('Permissions password')).toBeVisible();
  await dialog.getByRole('button', { name: 'Protect', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Enter a permissions password.');
  await dialog.getByLabel('Permissions password').fill('owner');
  await dialog.getByLabel('Print', { exact: true }).uncheck();
  await dialog.getByRole('button', { name: 'Protect', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(badge(page)).toBeVisible();
  const bytes = await downloaded(page);
  const reader = await unlockPdf(bytes, '');
  expect(reader.owner).toBe(false);
  expect((await unlockPdf(bytes, 'owner')).owner).toBe(true);
  const raw = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const encrypt = raw.context.lookup(raw.context.trailerInfo.Encrypt);
  const flags = encrypt.get(PDFName.of('P')).asNumber();
  expect(flags & 0x4).toBe(0);
  expect(flags & 0x10).toBe(0x10);
  expect(encrypt.get(PDFName.of('R')).asNumber()).toBe(6);
  // The same open and permissions password would make the restriction pointless.
  await menu(page, 'Change password…');
  const change = page.getByRole('dialog', { name: 'Change password' });
  await expect(change.getByLabel('Print', { exact: true })).not.toBeChecked();
  await change.getByLabel('Password to open').fill('owner');
  await change.getByLabel('Confirm password').fill('owner');
  await change.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(change.getByRole('alert')).toContainText('Use a different permissions password');
});

for (const [kind, readerPassword, equivalentOwner] of [
  ['Unicode normalization', 'reader123', 'ｒｅａｄｅｒ123'],
  ['UTF-8 truncation', '界'.repeat(43) + 'reader', '界'.repeat(43) + 'owner'],
  ['SASLprep', 'reader\u00ad', 'reader'],
])
  test(`rejects permissions passwords equivalent after ${kind}`, async ({ page }) => {
    await mockPuter(page);
    await page.goto('/');
    await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
    await menu(page, 'Protect with password…');
    const dialog = page.getByRole('dialog', { name: 'Protect with password', exact: true });
    await dialog.getByLabel('Password to open').fill(readerPassword);
    await dialog.getByLabel('Confirm password').fill(readerPassword);
    await dialog.getByLabel('Restrict printing, copying, or editing').check();
    await dialog.getByLabel('Permissions password', { exact: true }).fill(equivalentOwner);
    await dialog.getByLabel('Print', { exact: true }).uncheck();
    await dialog.getByRole('button', { name: 'Protect', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('Use a different permissions password');
    await expect(dialog.getByLabel('Permissions password', { exact: true })).toBeFocused();
    await expect(badge(page)).toBeHidden();
    // Correction must produce a PDF where the reader stays restricted and the owner unlocks it.
    await dialog.getByLabel('Permissions password', { exact: true }).fill('separate-owner');
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    const bytes = await downloaded(page);
    const reader = await unlockPdf(bytes, readerPassword);
    expect(reader.owner).toBe(false);
    expect(reader.encryption.security.P & 0x804).toBe(0);
    expect((await unlockPdf(bytes, 'separate-owner')).owner).toBe(true);
  });

test('inserting pages from a protected PDF asks for its password first', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([300, 300]);
  await openPdf(page, doc);
  const chooser = page.waitForEvent('filechooser');
  await menu(page, 'Insert pages from PDF…');
  await (
    await chooser
  ).setFiles({
    name: 'appendix.pdf',
    mimeType: 'application/pdf',
    buffer: await fixture('aes-128'),
  });
  const dialog = passwordDialog(page);
  await expect(dialog).toContainText('appendix.pdf is password protected');
  await dialog.getByLabel('Password', { exact: true }).fill('user');
  await page.keyboard.press('Enter');
  const insert = page.getByRole('dialog', { name: 'Insert pages' });
  await expect(insert).toContainText('appendix.pdf has 2 pages');
  await insert.getByRole('radio', { name: 'At the end', exact: true }).check();
  await insert.getByRole('button', { name: 'Insert pages', exact: true }).click();
  await expect(page.locator('#toast')).toHaveText('2 pages inserted at the end.');
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 3');
  // Only the document itself carries protection; inserting pages does not lock it.
  await expect(badge(page)).toBeHidden();
});

test('a page served without https explains that passwords need a secure connection', async ({
  page,
}) => {
  await mockPuter(page);
  // Web Crypto belongs to secure contexts; a plain-http deployment has none of it.
  await page.addInitScript(() => {
    Object.defineProperty(crypto, 'subtle', { get: () => undefined, configurable: true });
  });
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([300, 300]);
  await openPdf(page, doc);
  await menu(page, 'Protect with password…');
  await expect(page.locator('#toast')).toHaveText(/secure connection/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // An AES-256 file says the same instead of failing on a missing property.
  await page.goto('/#library');
  await chooseFile(page, await fixture('aes-256'));
  await expect(page.locator('#toast')).toHaveText(/secure connection/);
  // The older handlers hash with this app's own MD5, so those files still open.
  await page.goto('/#library');
  await chooseFile(page, await fixture('rc4-128'));
  await passwordDialog(page).getByLabel('Password', { exact: true }).fill('user');
  await passwordDialog(page).getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
});

test('rejects a password made only of characters that PDF passwords drop', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/');
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await menu(page, 'Protect with password…');
  const dialog = page.getByRole('dialog', { name: 'Protect with password', exact: true });
  await dialog.getByLabel('Password to open').fill('\u00ad\u200d');
  await dialog.getByLabel('Confirm password').fill('\u00ad\u200d');
  await dialog.getByRole('button', { name: 'Protect', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('This password is empty in the PDF.');
  await expect(dialog.getByLabel('Password to open')).toBeFocused();
  await expect(badge(page)).toBeHidden();
});
