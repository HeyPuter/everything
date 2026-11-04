import { clickAway } from './editing-helpers.js';
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { PDFDocument, PDFName, PDFHexString, PDFNumber } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import {
  protectPdf,
  unlockPdf,
  aesCbcDecrypt,
  aesCbcEncrypt,
  toHex,
} from '../../src/core/security.js';
import { addNote, listNotes } from '../../src/core/notes.js';
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
async function menuItem(page, name) {
  const bar = page.getByRole('menubar', { name: 'PDF menus' });
  const item = page.getByRole('menu').getByRole('menuitem', { name, exact: true });
  if (await bar.isVisible()) {
    for (const title of ['File', 'Edit', 'View', 'Page', 'Insert']) {
      await bar.getByRole('menuitem', { name: title, exact: true }).click();
      if (await item.count()) return item;
      await page.keyboard.press('Escape');
    }
  } else {
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    if (await item.count()) return item;
    for (const section of ['Edit', 'View', 'Page', 'Insert']) {
      await page.getByRole('menu').getByRole('menuitem', { name: section, exact: true }).click();
      if (await item.count()) return item;
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

const menu = async (page, name) => (await menuItem(page, name)).click();
const ownerDialog = (page) => page.getByRole('dialog', { name: 'Permissions password required' });
async function restricted(bits = 0, open = 'reader') {
  const doc = await PDFDocument.create();
  const first = doc.addPage([400, 500]);
  first.drawText('Restricted report', { x: 25, y: 450, size: 20 });
  doc.addPage([400, 500]).drawText('Second sheet');
  const field = doc.getForm().createTextField('Name');
  field.setText('Grace');
  field.addToPage(first, { x: 40, y: 340, width: 180, height: 30 });
  addNote(doc, 0, { x: 240, y: 380, text: 'Keep this comment' });
  const bytes = await protectPdf(await doc.save(), { open, permissions: 'owner' });
  const {
    encryption: { fileKey },
  } = await unlockPdf(bytes, 'owner');
  const raw = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const dict = raw.context.lookup(raw.context.trailerInfo.Encrypt);
  const P = 0xfffff0c0 | bits | 0;
  dict.set(PDFName.of('P'), PDFNumber.of(P));
  const perms = aesCbcDecrypt(
    fileKey,
    new Uint8Array(16),
    dict.lookup(PDFName.of('Perms')).asBytes(),
  );
  new DataView(perms.buffer, perms.byteOffset, perms.length).setInt32(0, P, true);
  dict.set(
    PDFName.of('Perms'),
    PDFHexString.of(toHex(aesCbcEncrypt(fileKey, new Uint8Array(16), perms))),
  );
  return Buffer.from(await raw.save({ useObjectStreams: false, updateFieldAppearances: false }));
}
async function openRestricted(page, bytes, password = 'reader') {
  await mockPuter(page);
  await page.goto('/#library');
  await chooseFile(page, bytes);
  if (password !== '') {
    const dialog = page.getByRole('dialog', { name: 'Password required' });
    await dialog.getByLabel('Password', { exact: true }).fill(password);
    await dialog.getByRole('button', { name: 'Open', exact: true }).click();
  }
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
}
async function unlockedDownload(page) {
  const bytes = await downloaded(page);
  const user = await unlockPdf(bytes, 'reader');
  expect(user.owner).toBe(false);
  expect((await unlockPdf(bytes, 'owner')).owner).toBe(true);
  return PDFDocument.load(user.bytes);
}

test('non-owner restrictions cover tools, menus, clipboard, native printing, and downloaded protection', async ({
  page,
}) => {
  await openRestricted(page, await restricted());
  for (const label of ['Text', 'Highlight', 'Draw', 'Shape', 'Note', 'Image', 'Sign', 'Fill forms'])
    await expect(
      page.getByRole('toolbar').getByRole('button', { name: label, exact: true }),
    ).toBeDisabled();
  await expect(page.getByLabel('Name (on page)', { exact: true })).toBeDisabled();
  // Revision 6 always permits accessibility, even with its old accessibility bit clear.
  await expect(page.getByRole('region', { name: 'Page text', exact: true })).toContainText(
    'Restricted report',
  );
  for (const label of [
    'Print…',
    'Reduce file size…',
    'Flatten…',
    'Split PDF…',
    'Download pages as images…',
    'Rotate clockwise',
    'Extract pages…',
    'Fill forms…',
  ]) {
    await expect(await menuItem(page, label)).toBeDisabled();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
  }
  expect(
    await page.locator('.textLayer').evaluate((node) => {
      const event = new Event('copy', { bubbles: true, cancelable: true });
      node.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  ).toBe(true);
  for (const [selector, type] of [
    ['.paper > canvas:first-child', 'contextmenu'],
    ['.textLayer', 'dragstart'],
  ])
    expect(
      await page.locator(selector).evaluate((node, type) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        node.dispatchEvent(event);
        return event.defaultPrevented;
      }, type),
    ).toBe(true);
  await page.keyboard.press('ControlOrMeta+p');
  await expect(page.getByRole('dialog', { name: 'Print', exact: true })).toHaveCount(0);
  await expect(page.locator('#toast')).toContainText('does not allow printing');
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('#app')).toBeHidden();
  await expect(page.locator('.print-permissions-message')).toContainText('Printing is not allowed');
  await page.emulateMedia({ media: 'screen' });
  await menu(page, 'Document details…');
  await expect(page.getByLabel('Title', { exact: true })).toHaveJSProperty('readOnly', true);
  await expect(page.getByRole('button', { name: 'Save details' })).toHaveCount(0);
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: /Read note: Keep this comment/ }).click();
  await expect(page.getByLabel('Note text', { exact: true })).toHaveJSProperty('readOnly', true);
  await expect(page.getByRole('button', { name: 'Delete note', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close note', exact: true }).click();
  const doc = await unlockedDownload(page);
  expect(doc.getForm().getTextField('Name').getText()).toBe('Grace');
  expect(doc.getPage(0).getRotation().angle).toBe(0);
});

test('changing or removing protection requires the owner password, and owner access survives undo', async ({
  page,
}) => {
  await openRestricted(page, await restricted());
  await menu(page, 'Remove password');
  const dialog = ownerDialog(page);
  await expect(dialog.getByLabel('Document permissions')).toContainText(
    'Editing contentNot allowed',
  );
  const accessibility = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  for (const wrong of ['wrong', 'reader']) {
    await dialog.getByLabel('Permissions password').fill(wrong);
    await dialog.getByRole('button', { name: 'Unlock', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('password used only to open');
    await expect(
      page.getByRole('toolbar').getByRole('button', { name: 'Text', exact: true }),
    ).toBeDisabled();
  }
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Protected', exact: true }).click();
  await dialog.getByLabel('Permissions password').fill('owner');
  await dialog.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole('toolbar').getByRole('button', { name: 'Text', exact: true }),
  ).toBeEnabled();
  await expect(page.locator('.save-status')).toHaveText('Local file');
  await menu(page, 'Rotate clockwise');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(
    page.getByRole('toolbar').getByRole('button', { name: 'Text', exact: true }),
  ).toBeEnabled();
  await unlockedDownload(page);
  await menu(page, 'Remove password');
  await expect(page.getByRole('button', { name: 'Protected', exact: true })).toBeHidden();
  await expect(ownerDialog(page)).toHaveCount(0);
  expect((await PDFDocument.load(await downloaded(page))).getPageCount()).toBe(2);
});

test('form-only access can fill, undo, redo, and export values while content and annotations remain locked', async ({
  page,
}) => {
  await openRestricted(page, await restricted(0x100));
  const input = page.getByLabel('Name (on page)', { exact: true });
  await expect(input).toBeEnabled();
  await expect(
    page.getByRole('toolbar').getByRole('button', { name: 'Note', exact: true }),
  ).toBeDisabled();
  await input.fill('Ada');
  await input.blur();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(input).toHaveValue('Grace');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(input).toHaveValue('Ada');
  const doc = await unlockedDownload(page);
  expect(doc.getForm().getTextField('Name').getText()).toBe('Ada');
  await expect(
    page.getByRole('toolbar').getByRole('button', { name: 'Text', exact: true }),
  ).toBeDisabled();
});

test('form-only access can save through the Fill forms dialog', async ({ page }) => {
  await openRestricted(page, await restricted(0x100));
  await menu(page, 'Fill forms…');
  const dialog = page.getByRole('dialog', { name: 'Fill forms', exact: true });
  await dialog.getByLabel('Name', { exact: true }).fill('Ada');
  await dialog.getByRole('button', { name: 'Save form', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  const doc = await unlockedDownload(page);
  expect(doc.getForm().getTextField('Name').getText()).toBe('Ada');
  await expect(
    page.getByRole('toolbar').getByRole('button', { name: 'Text', exact: true }),
  ).toBeDisabled();
});

test('annotation permission permits notes and form filling without content editing', async ({
  page,
}) => {
  await openRestricted(page, await restricted(0x20));
  await expect(page.getByLabel('Name (on page)', { exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Note', exact: true }).click();
  await page.getByRole('button', { name: 'Place at page center', exact: true }).click();
  await page.getByLabel('New note text').fill('Allowed annotation');
  await clickAway(page);
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  const doc = await unlockedDownload(page);
  expect(listNotes(doc, 0).map((note) => note.text)).toEqual([
    'Keep this comment',
    'Allowed annotation',
  ]);
  await expect(
    page.getByRole('toolbar').getByRole('button', { name: 'Text', exact: true }),
  ).toBeDisabled();
});

test('assembly-only access can rotate and insert pages without content editing or extraction', async ({
  page,
}) => {
  await openRestricted(page, await restricted(0x400));
  await menu(page, 'Rotate clockwise');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await menu(page, 'Insert blank page after');
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 3');
  const doc = await unlockedDownload(page);
  expect(doc.getPageCount()).toBe(3);
  expect(doc.getPage(0).getRotation().angle).toBe(90);
  await expect(await menuItem(page, 'Extract pages…')).toBeDisabled();
});

test('Organize pages offers no page changes the PDF does not allow, on its tiles either', async ({
  page,
}) => {
  await openRestricted(page, await restricted());
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page
    .getByRole('complementary', { name: 'Tools' })
    .getByRole('button', { name: 'Organize pages', exact: true })
    .click();
  const grid = page.getByRole('listbox', { name: 'Pages' });
  await expect(grid.getByRole('option')).toHaveCount(2);
  const toolbar = page.getByRole('toolbar', { name: 'Organize pages' });
  await expect(
    toolbar.getByRole('button', { name: 'Rotate clockwise', exact: true }),
  ).toBeDisabled();
  for (const label of [
    'Rotate page 1 counterclockwise',
    'Rotate page 1 clockwise',
    'Delete page 1',
    'Delete page 2',
  ])
    await expect(grid.getByRole('button', { name: label, exact: true })).toBeDisabled();
});

test('low-resolution printing uses the allowed raster resolution and protects the native print route', async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.printedWidths = [];
    window.print = () => {
      window.printedWidths = [...document.querySelectorAll('.print-sheet img')].map(
        (image) => image.naturalWidth,
      );
      window.dispatchEvent(new Event('afterprint'));
    };
  });
  await openRestricted(page, await restricted(0x4));
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('#app')).toBeHidden();
  await expect(page.locator('.print-permissions-message')).toContainText('allowed resolution');
  await page.emulateMedia({ media: 'screen' });
  await page.keyboard.press('ControlOrMeta+p');
  await page
    .getByRole('dialog', { name: 'Print', exact: true })
    .getByRole('button', { name: 'Print', exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.printedWidths))
    .toEqual([Math.ceil((400 * 150) / 72), Math.ceil((400 * 150) / 72)]);
});

test('extracted and split PDFs retain both passwords and restrictions', async ({ page }) => {
  await openRestricted(page, await restricted(0x10));
  await menu(page, 'Extract pages…');
  let pending = page.waitForEvent('download');
  await page
    .getByRole('dialog', { name: 'Extract pages' })
    .getByRole('button', { name: 'Download pages' })
    .click();
  const bytes = new Uint8Array(await readFile(await (await pending).path()));
  expect((await unlockPdf(bytes, 'reader')).owner).toBe(false);
  const owner = await unlockPdf(bytes, 'owner');
  expect(owner.encryption.security.P & 0x8).toBe(0);
  expect((await PDFDocument.load(owner.bytes)).getPageCount()).toBe(1);
  await menu(page, 'Split PDF…');
  pending = page.waitForEvent('download');
  await page
    .getByRole('dialog', { name: 'Split PDF' })
    .getByRole('button', { name: 'Download ZIP' })
    .click();
  const zip = new Uint8Array(await readFile(await (await pending).path()));
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let at = 0,
    parts = 0;
  while (view.getUint32(at, true) === 0x04034b50) {
    const size = view.getUint32(at + 18, true);
    const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
    const part = zip.slice(start, start + size);
    expect((await unlockPdf(part, 'reader')).owner).toBe(false);
    expect((await unlockPdf(part, 'owner')).owner).toBe(true);
    at = start + size;
    parts++;
  }
  expect(parts).toBe(2);
});

test('importing pages from a copy-restricted source requires its owner password', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/');
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  const chooser = page.waitForEvent('filechooser');
  await menu(page, 'Insert pages from PDF…');
  await (
    await chooser
  ).setFiles({
    name: 'restricted.pdf',
    mimeType: 'application/pdf',
    buffer: await restricted(0, ''),
  });
  const dialog = ownerDialog(page);
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Insert pages', exact: true })).toHaveCount(0);
  await dialog.getByLabel('Permissions password').fill('reader');
  await dialog.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await dialog.getByLabel('Permissions password').fill('owner');
  await dialog.getByRole('button', { name: 'Unlock', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Insert pages', exact: true })
    .getByRole('button', { name: 'Insert pages', exact: true })
    .click();
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 3');
});

test('a cancelled owner check cannot unlock the document or report errors in a later dialog', async ({
  page,
}) => {
  await openRestricted(page, await restricted());
  await page.getByRole('button', { name: 'Protected', exact: true }).click();
  await page.evaluate(() => {
    const digest = SubtleCrypto.prototype.digest;
    let first = true;
    SubtleCrypto.prototype.digest = async function (...args) {
      const result = await digest.apply(this, args);
      if (first) {
        first = false;
        await new Promise((resolve) => {
          window.releaseOwnerCheck = resolve;
        });
      }
      return result;
    };
  });
  const dialog = ownerDialog(page);
  await dialog.getByLabel('Permissions password').fill('owner');
  await dialog.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect.poll(() => page.evaluate(() => !!window.releaseOwnerCheck)).toBe(true);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await menu(page, 'Document details…');
  await page.evaluate(() => window.releaseOwnerCheck());
  await expect(page.getByRole('dialog', { name: 'Document details' })).toBeVisible();
  await expect(
    page.getByRole('toolbar').getByRole('button', { name: 'Text', exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole('dialog').getByRole('alert')).toBeHidden();
});

test('opening with the owner password grants access despite every user permission being denied', async ({
  page,
}) => {
  await openRestricted(page, await restricted(), 'owner');
  for (const label of ['Text', 'Highlight', 'Draw', 'Shape', 'Note', 'Image', 'Sign', 'Fill forms'])
    await expect(
      page.getByRole('toolbar').getByRole('button', { name: label, exact: true }),
    ).toBeEnabled();
  await expect(page.getByLabel('Name (on page)', { exact: true })).toBeEnabled();
  expect(
    await page
      .locator('.textLayer')
      .evaluate((node) =>
        node.dispatchEvent(new Event('copy', { bubbles: true, cancelable: true })),
      ),
  ).toBe(true);
  await menu(page, 'Remove password');
  await expect(ownerDialog(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Protected', exact: true })).toBeHidden();
  expect((await PDFDocument.load(await downloaded(page))).getPageCount()).toBe(2);
});

test('damaged encrypted permissions are reported without replacing the open document', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/');
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  const raw = await PDFDocument.load(await restricted(0, ''), {
    ignoreEncryption: true,
    updateMetadata: false,
  });
  raw.context
    .lookup(raw.context.trailerInfo.Encrypt)
    .set(PDFName.of('Perms'), PDFHexString.of('00'.repeat(16)));
  const chooser = page.waitForEvent('filechooser');
  await menu(page, 'Open…');
  await (
    await chooser
  ).setFiles({
    name: 'damaged.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await raw.save({ useObjectStreams: false, updateFieldAppearances: false })),
  });
  await expect(page.locator('#toast')).toContainText('invalid encrypted permissions data');
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await expect(page.locator('.document-name')).toHaveText('Untitled');
  await expect(page.getByRole('button', { name: 'Protected', exact: true })).toBeHidden();
});
