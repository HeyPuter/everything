import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, PDFNumber, StandardFonts, PDFString, degrees } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { protectPdf } from '../../src/core/security.js';
import { listLinks } from '../../src/core/links.js';

const PUTER_MOCK = `window.puter = { env: 'web', auth: { isSignedIn: () => true, getUser: async () => ({username:'test-user'}), signIn: async () => {}, signOut: async () => {} }, fs: { readdir: async () => [], write: async () => ({}) }, ui: { onLaunchedWithItems: () => {}, onItemsOpened: () => {} } };`;
async function mockPuter(page) {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
  );
}
async function openPdf(page, doc) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'test.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText(`Page 1 of ${doc.getPageCount()}`);
}
/** Choose a menu item by name from the menu bar, or from the folded phone menu. */
async function menu(page, name) {
  const bar = page.getByRole('menubar', { name: 'PDF menus' });
  const item = page.getByRole('menu').getByRole('menuitem', { name, exact: true });
  if (await bar.isVisible()) {
    for (const title of ['Insert', 'File', 'Edit', 'View', 'Page']) {
      await bar.getByRole('menuitem', { name: title, exact: true }).click();
      if (await item.count()) return item.click();
      await page.keyboard.press('Escape');
    }
  } else {
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    if (await item.count()) return item.click();
    for (const section of ['Insert', 'Edit', 'View', 'Page']) {
      await page.getByRole('menu').getByRole('menuitem', { name: section, exact: true }).click();
      if (await item.count()) return item.click();
      await page.keyboard.press('Escape');
    }
  }
  throw new Error(`No menu item named ${name}`);
}
async function exported(page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  return PDFDocument.load(await readFile(await (await pending).path()));
}
const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
/** Two pages; the first carries a web link and a link to the second page. */
async function linkedPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const first = doc.addPage([400, 400]);
  first.drawText('Visit our website', { x: 40, y: 340, size: 18, font });
  first.drawText('See the appendix', { x: 40, y: 240, size: 18, font });
  doc.addPage([400, 400]).drawText('Appendix', { x: 40, y: 340, size: 18, font });
  const annots = [
    doc.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [40, 335, 200, 360],
      Border: [0, 0, 0],
      A: { S: 'URI', URI: PDFString.of('https://example.com/') },
    }),
    doc.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [40, 235, 200, 260],
      Border: [0, 0, 0],
      Dest: [doc.getPage(1).ref, 'Fit'],
    }),
  ];
  for (const annot of annots) first.node.addAnnot(doc.context.register(annot));
  return doc;
}

for (const indirectAction of [false, true])
  test(`numeric page links follow the same page through insertion, reordering, download and undo (indirect action ${indirectAction})`, async ({
    page,
  }) => {
    await mockPuter(page);
    await page.goto('/#library');
    const doc = await linkedPdf();
    const link = doc.context.lookup(doc.getPage(0).node.Annots().get(1));
    const dest = link.lookup(PDFName.of('Dest'));
    dest.set(0, PDFNumber.of(1));
    if (indirectAction) {
      link.delete(PDFName.of('Dest'));
      link.set(
        PDFName.of('A'),
        doc.context.obj({ S: doc.context.register(PDFName.of('GoTo')), D: dest }),
      );
    }
    await openPdf(page, doc);
    const jump = page.getByRole('button', { name: 'Link to another page', exact: true });
    await jump.click();
    await page
      .getByRole('dialog', { name: 'Edit link' })
      .getByRole('button', { name: 'Go to linked page' })
      .click();
    await expect(page.locator('.page-caption')).toHaveText('Page 2 of 2');
    await page.getByRole('button', { name: 'Previous page', exact: true }).click();
    await menu(page, 'Insert blank page after');
    await expect(page.locator('.page-caption')).toHaveText('Page 2 of 3');
    await settled(page);
    await page.getByRole('button', { name: 'Previous page', exact: true }).click();
    await jump.click();
    await page
      .getByRole('dialog', { name: 'Edit link' })
      .getByRole('button', { name: 'Go to linked page' })
      .click();
    await expect(page.locator('.page-caption')).toHaveText('Page 3 of 3');
    await menu(page, 'Move page earlier');
    await expect(page.locator('.page-caption')).toHaveText('Page 2 of 3');
    await settled(page);
    await page.getByRole('button', { name: 'Previous page', exact: true }).click();
    await jump.click();
    await page
      .getByRole('dialog', { name: 'Edit link' })
      .getByRole('button', { name: 'Go to linked page' })
      .click();
    await expect(page.locator('.page-caption')).toHaveText('Page 2 of 3');
    const saved = await exported(page);
    const savedLink = saved.context.lookup(saved.getPage(0).node.Annots().get(1));
    const destination = indirectAction
      ? savedLink.lookup(PDFName.of('A')).lookup(PDFName.of('D'))
      : savedLink.lookup(PDFName.of('Dest'));
    expect(destination.get(0)).toBe(saved.getPage(1).ref);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await settled(page);
    await page.getByRole('button', { name: 'Previous page', exact: true }).click();
    await jump.click();
    await page
      .getByRole('dialog', { name: 'Edit link' })
      .getByRole('button', { name: 'Go to linked page' })
      .click();
    await expect(page.locator('.page-caption')).toHaveText('Page 3 of 3');
  });

test('links edit on click, open explicitly, and can be removed from their menu', async ({
  page,
  context,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await linkedPdf());
  const web = page.getByRole('button', { name: 'Link to example.com' });
  await expect(web).toBeVisible();
  await page.evaluate(() => {
    window.openedLinks = [];
    window.open = (...args) => window.openedLinks.push(args);
  });
  await web.click();
  const editor = page.getByRole('dialog', { name: 'Edit link' });
  await expect(editor.getByRole('textbox', { name: 'Web address to link to' })).toHaveValue(
    'https://example.com/',
  );
  expect(await page.evaluate(() => window.openedLinks)).toEqual([]);
  expect(context.pages()).toHaveLength(1);
  await editor.getByRole('button', { name: 'Open link', exact: true }).click();
  expect(await page.evaluate(() => window.openedLinks)).toEqual([
    ['https://example.com/', '_blank', 'noopener'],
  ]);
  await expect(editor).toHaveCount(0);
  const jump = page.getByRole('button', { name: 'Link to another page', exact: true });
  await expect(jump).toBeVisible();
  // The editing targets sit over their text.
  const text = page.locator('.workspace .textLayer').getByText('Visit our website');
  const anchorBox = await web.boundingBox(),
    textBox = await text.boundingBox();
  expect(anchorBox.x).toBeLessThanOrEqual(textBox.x + 2);
  expect(anchorBox.x + anchorBox.width).toBeGreaterThanOrEqual(textBox.x + textBox.width - 2);
  await jump.click();
  await page
    .getByRole('dialog', { name: 'Edit link' })
    .getByRole('button', { name: 'Go to linked page' })
    .click();
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 2');
  await expect(page.getByRole('button', { name: /Link to/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Previous page', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
  await settled(page);
  // Other tools can edit the content underneath a link.
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Link to example.com' })).toBeHidden();
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Link to example.com' }).click({ button: 'right' });
  const linkMenu = page.getByRole('menu');
  await expect(linkMenu.getByRole('menuitem', { name: 'Open link', exact: true })).toBeVisible();
  await linkMenu.getByRole('menuitem', { name: 'Remove link', exact: true }).click();
  await expect(page.locator('#toast')).toHaveText('Link removed.');
  await settled(page);
  await expect(page.getByRole('button', { name: 'Link to example.com' })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Link to another page', exact: true }),
  ).toBeVisible();
  const doc = await exported(page);
  const remaining = listLinks(doc, 0);
  expect(remaining).toHaveLength(1);
  expect(remaining[0].url).toBeNull();
  void context;
});

test('encoded address limits keep the link dialog open for correction', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await linkedPdf());
  await page.getByRole('button', { name: 'Link to example.com', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit link' });
  const address = editor.getByRole('textbox', { name: 'Web address to link to' });
  const oversized = 'https://example.com/' + '界'.repeat(230);
  await address.fill(oversized);
  await editor.getByRole('button', { name: 'Save link', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('2,048');
  await expect(editor).toBeVisible();
  await expect(address).toHaveValue(oversized);
  await expect(address).toBeFocused();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  const corrected = 'https://example.com/' + '界'.repeat(225) + 'abc';
  await address.fill(corrected);
  await editor.getByRole('button', { name: 'Save link', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await settled(page);
  expect(listLinks(await exported(page), 0)[0].url).toBe(new URL(corrected).href);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await settled(page);
  await expect(
    page.getByRole('button', { name: 'Link to example.com', exact: true }),
  ).toBeVisible();
});

test('links with script, data, or file addresses never become anchors', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const sheet = doc.addPage([400, 400]);
  const targets = [
    ['javascript:alert(document.domain)', 340],
    ['data:text/html,<script>alert(1)</script>', 280],
    ['file:///etc/passwd', 220],
    ['https://example.com/', 160],
  ];
  for (const [uri, y] of targets) {
    sheet.drawText(uri.slice(0, 24), { x: 40, y: y + 4, size: 12, font });
    sheet.node.addAnnot(
      doc.context.register(
        doc.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [40, y - 4, 360, y + 18],
          Border: [0, 0, 0],
          A: { S: 'URI', URI: PDFString.of(uri) },
        }),
      ),
    );
  }
  await openPdf(page, doc);
  // No link target navigates, including addresses that a browser must never open.
  await expect(page.locator('a.link-target')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Link to example.com' })).toBeVisible();
  const blocked = page.getByRole('button', { name: 'Link with an unsupported address' });
  await expect(blocked).toHaveCount(3);
  await expect(page.locator('.link-target[href^="javascript"]')).toHaveCount(0);
  await expect(page.locator('.link-target[href^="data"]')).toHaveCount(0);
  await expect(page.locator('.link-target[href^="file"]')).toHaveCount(0);
  const pagesBefore = page.context().pages().length;
  await blocked.first().click();
  const editor = page.getByRole('dialog', { name: 'Edit link' });
  await expect(editor.getByRole('button', { name: 'Open link' })).toHaveCount(0);
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(page.context().pages().length).toBe(pagesBefore);
  // The menu can edit or remove an unsupported address but never opens it.
  await blocked.first().click({ button: 'right' });
  const linkMenu = page.getByRole('menu');
  await expect(linkMenu.getByRole('menuitem', { name: /Open link|Go to linked page/ })).toHaveCount(
    0,
  );
  await linkMenu.getByRole('menuitem', { name: 'Remove link', exact: true }).click();
  await expect(page.locator('#toast')).toHaveText('Link removed.');
  await settled(page);
  await expect(blocked).toHaveCount(2);
  const exportedDoc = await exported(page);
  expect(listLinks(exportedDoc, 0).map((l) => l.url)).toEqual([
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'https://example.com/',
  ]);
});

test('next-page links are followed, and links that run scripts can be removed', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const sheet = doc.addPage([400, 400]);
  for (let i = 2; i <= 3; i++)
    doc.addPage([400, 400]).drawText(`Page ${i}`, { x: 40, y: 340, size: 18, font });
  const actions = [
    [{ S: 'Named', N: 'NextPage' }, 340],
    [{ S: 'JavaScript', JS: PDFString.of('app.alert(1)') }, 280],
    [{ S: 'SubmitForm', F: { FS: 'URL', F: PDFString.of('https://example.com/') } }, 220],
    [{ S: 'Named', N: 'LastPage' }, 160],
  ];
  for (const [action, y] of actions) {
    sheet.drawText(action.N || action.S, { x: 40, y: y + 4, size: 12, font });
    sheet.node.addAnnot(
      doc.context.register(
        doc.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [40, y - 4, 360, y + 18],
          Border: [0, 0, 0],
          A: action,
        }),
      ),
    );
  }
  await openPdf(page, doc);
  await settled(page);
  const pageLinks = page.getByRole('button', { name: 'Link to another page', exact: true });
  const unsupported = page.getByRole('button', { name: 'Link with an unsupported action' });
  await expect(pageLinks).toHaveCount(2);
  await expect(unsupported).toHaveCount(2);
  // A link that runs a script is never followed, but its menu can remove it.
  await unsupported.first().click({ button: 'right' });
  const linkMenu = page.getByRole('menu');
  await expect(linkMenu.getByRole('menuitem', { name: /Open link|Go to linked page/ })).toHaveCount(
    0,
  );
  await linkMenu.getByRole('menuitem', { name: 'Remove link', exact: true }).click();
  await expect(page.locator('#toast')).toHaveText('Link removed.');
  await settled(page);
  await expect(unsupported).toHaveCount(1);
  // "Next page" opens on the page it goes to, and goes there.
  await pageLinks.first().click();
  const editor = page.getByRole('dialog', { name: 'Edit link' });
  await expect(editor.getByRole('spinbutton', { name: 'Page to link to' })).toHaveValue('2');
  await editor.getByRole('button', { name: 'Go to linked page' }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 3');
});

test('the Link tool links a dragged area to a typed address or a page, with undo', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([400, 400]).drawText('Read the docs', { x: 40, y: 300, size: 18, font });
  doc.addPage([400, 400]);
  await openPdf(page, doc);
  await menu(page, 'Link…');
  await expect(page.locator('.tool-hint')).toContainText('should open a web address');
  const overlay = page.locator('.drawing-overlay');
  const box = await overlay.boundingBox();
  const scale = box.width / 400;
  await page.mouse.move(box.x + 35 * scale, box.y + (400 - 320) * scale);
  await page.mouse.down();
  await page.mouse.move(box.x + 180 * scale, box.y + (400 - 290) * scale, { steps: 5 });
  await page.mouse.up();
  const dialog = page.getByRole('dialog', { name: 'Add link' });
  await expect(dialog.getByRole('radio', { name: 'Web address' })).toBeChecked();
  await expect(dialog.getByRole('textbox', { name: 'Web address to link to' })).toBeVisible();
  await dialog.getByPlaceholder('example.com/page').fill('not a url');
  await dialog.getByRole('button', { name: 'Add link', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('valid web address');
  await dialog.getByPlaceholder('example.com/page').fill('example.org/docs');
  await dialog.getByPlaceholder('example.com/page').press('Enter');
  await expect(dialog).toBeHidden();
  await expect(page.locator('#toast')).toHaveText('Link added.');
  await settled(page);
  const added = page.getByRole('button', { name: 'Link to example.org/docs' });
  await expect(added).toBeVisible();
  await expect(added).toHaveAttribute('aria-haspopup', 'dialog');
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // A page link from the keyboard path lands at the page center.
  await menu(page, 'Link…');
  await page.getByRole('button', { name: 'Place at page center', exact: true }).click();
  const second = page.getByRole('dialog', { name: 'Add link' });
  await second.getByRole('radio', { name: 'Page in this PDF' }).check();
  await second.getByRole('spinbutton', { name: 'Page to link to' }).fill('2');
  await second.getByRole('button', { name: 'Add link', exact: true }).click();
  await expect(second).toBeHidden();
  await settled(page);
  await page.getByRole('button', { name: 'Link to another page', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Edit link' })
    .getByRole('button', { name: 'Go to linked page' })
    .click();
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 2');
  await page.getByRole('button', { name: 'Previous page', exact: true }).click();
  await settled(page);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await settled(page);
  await expect(page.getByRole('button', { name: 'Link to another page', exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole('button', { name: 'Link to example.org/docs' })).toBeVisible();
  const exportedDoc = await exported(page);
  expect(listLinks(exportedDoc, 0).map((l) => l.url)).toEqual(['https://example.org/docs']);
});

for (const [address, expected] of [
  ['example.org:8443/docs', 'https://example.org:8443/docs'],
  ['[2001:db8::1]:8443/docs', 'https://[2001:db8::1]:8443/docs'],
])
  test(`a link to ${address} survives export and reopening`, async ({ page }) => {
    await mockPuter(page);
    await page.goto('/');
    await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
    await menu(page, 'Link…');
    await page.getByRole('button', { name: 'Place at page center', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add link' });
    await dialog.getByRole('textbox', { name: 'Web address to link to' }).fill(address);
    await dialog.getByRole('button', { name: 'Add link', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const link = page.getByRole('button', { name: `Link to ${address}`, exact: true });
    await expect(link).toBeVisible();
    const saved = await exported(page);
    expect(listLinks(saved, 0).map((link) => link.url)).toEqual([expected]);
    await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
    await openPdf(page, saved);
    await expect(link).toBeVisible();
  });

test('a link address copies without the clipboard API, as a plain-http page has', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await mockPuter(page);
  // The clipboard API belongs to secure contexts alone; a page served over plain http has none.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { get: () => undefined, configurable: true });
  });
  await page.goto('/#library');
  await openPdf(page, await linkedPdf());
  await page.getByRole('button', { name: 'Link to example.com' }).click({ button: 'right' });
  await page.getByRole('menu').getByRole('menuitem', { name: 'Copy link address' }).click();
  await expect(page.locator('#toast')).toHaveText('Link address copied.');
  // A second tab of the same origin keeps the clipboard API and reads back what was copied.
  const reader = await context.newPage();
  await reader.goto('/#library');
  await expect
    .poll(() => reader.evaluate(() => navigator.clipboard.readText()))
    .toBe('https://example.com/');
  await reader.close();
});

test('clicking or using the keyboard edits a link without navigating, with cancel, undo, redo and export', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const source = await linkedPdf();
  const original = listLinks(source, 0)[0];
  await openPdf(page, source);
  const target = page.locator(`[data-link-id="${original.id}"]`);
  const editor = page.getByRole('dialog', { name: 'Edit link' });
  const address = editor.getByRole('textbox', { name: 'Web address to link to' });
  const save = editor.getByRole('button', { name: 'Save link', exact: true });
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  await target.click();
  await expect(address).toHaveValue(original.url);
  await address.fill('example.org/cancelled');
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
  await expect(undo).toBeDisabled();
  await expect(target).toBeFocused();
  await page.keyboard.press('Enter');
  await save.click();
  await expect(editor).toHaveCount(0);
  await expect(undo).toBeDisabled();
  await target.click();
  await address.fill('javascript:alert(1)');
  await save.click();
  await expect(editor.getByRole('alert')).toContainText('web pages, email addresses');
  await address.fill('example.org/updated');
  await address.press('Enter');
  await expect(editor).toHaveCount(0);
  await settled(page);
  await expect(target).toHaveAccessibleName('Link to example.org/updated');
  await expect(target).toBeFocused();
  expect(listLinks(await exported(page), 0)[0]).toEqual({
    ...original,
    url: 'https://example.org/updated',
  });
  await undo.click();
  await settled(page);
  await expect(target).toHaveAccessibleName('Link to example.com');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await settled(page);
  await expect(target).toHaveAccessibleName('Link to example.org/updated');
  await target.click();
  await editor.getByRole('spinbutton', { name: 'Page to link to' }).fill('2');
  await save.click();
  await settled(page);
  await expect(target).toHaveAccessibleName('Link to another page');
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
  await target.click();
  await expect(editor.getByRole('radio', { name: 'Page in this PDF' })).toBeChecked();
  await expect(editor.getByRole('spinbutton', { name: 'Page to link to' })).toHaveValue('2');
  await editor.getByRole('button', { name: 'Go to linked page', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 2');
  await page.getByRole('button', { name: 'Previous page', exact: true }).click();
  await target.click();
  await address.fill('example.net/final');
  await save.click();
  await settled(page);
  const saved = await exported(page);
  expect(listLinks(saved, 0)[0]).toEqual({ ...original, url: 'https://example.net/final' });
  const annotation = saved.context.lookup(saved.getPage(0).node.Annots().get(0));
  expect(annotation.has(PDFName.of('Dest'))).toBe(false);
  await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
  await openPdf(page, saved);
  await target.click();
  await expect(address).toHaveValue('https://example.net/final');
  await page.keyboard.press('Escape');
});

test('protected links offer explicit navigation while editing remains disabled', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const source = await linkedPdf();
  const bytes = await protectPdf(await source.save(), {
    permissions: 'test-owner',
    allow: { annotate: false, edit: false },
  });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({ name: 'protected.pdf', mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
  await page.getByRole('button', { name: 'Link to another page', exact: true }).click();
  const options = page.getByRole('menu', { name: 'Link', exact: true });
  await expect(options.getByRole('menuitem', { name: 'Edit link…', exact: true })).toBeDisabled();
  await expect(options.getByRole('menuitem', { name: 'Remove link', exact: true })).toBeDisabled();
  await expect(page.getByRole('dialog', { name: 'Edit link' })).toHaveCount(0);
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
  await options.getByRole('menuitem', { name: 'Go to linked page', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 2');
});

test('saving an unchanged page link at a different zoom preserves its exact destination and history', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const source = await linkedPdf();
  source.getPage(0).setRotation(degrees(90));
  const annotation = source.context.lookup(source.getPage(0).node.Annots().get(1));
  const destination = source.context.obj([source.getPage(1).ref, 'XYZ', 40, 200, 1.5]);
  annotation.set(PDFName.of('Dest'), destination);
  await openPdf(page, source);
  await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('0.5');
  const target = page.getByRole('button', { name: 'Link to another page', exact: true });
  await target.click();
  const editor = page.getByRole('dialog', { name: 'Edit link' });
  await expect(editor.getByRole('spinbutton', { name: 'Page to link to' })).toHaveValue('2');
  await editor.getByRole('button', { name: 'Save link', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  const saved = await exported(page);
  expect(
    saved.context
      .lookup(saved.getPage(0).node.Annots().get(1))
      .lookup(PDFName.of('Dest'))
      .toString(),
  ).toBe(destination.toString());
});

for (const flags of [64, 128, 128 | 512]) {
  test(`links with flags ${flags} cannot be edited or removed`, async ({ page }) => {
    await mockPuter(page);
    await page.goto('/#library');
    const doc = await linkedPdf();
    for (const ref of doc.getPage(0).node.Annots().asArray())
      doc.context.lookup(ref).set(PDFName.of('F'), PDFNumber.of(4 | flags));
    await openPdf(page, doc);
    const web = page.getByRole('button', { name: 'Link to example.com', exact: true });
    await web.click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'Link', exact: true });
    await expect(menu.getByRole('menuitem', { name: 'Edit link…', exact: true })).toBeDisabled();
    await expect(menu.getByRole('menuitem', { name: 'Remove link', exact: true })).toBeDisabled();
    if (flags & 64)
      await expect(menu.getByRole('menuitem', { name: 'Open link', exact: true })).toBeDisabled();
    else await expect(menu.getByRole('menuitem', { name: 'Open link', exact: true })).toBeEnabled();
    await page.keyboard.press('Escape');
    await web.click();
    await expect(page.getByRole('dialog', { name: 'Edit link', exact: true })).toHaveCount(0);
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    const saved = await exported(page);
    expect(listLinks(saved, 0)).toEqual(listLinks(doc, 0));
    for (const ref of saved.getPage(0).node.Annots().asArray())
      expect(saved.context.lookup(ref).lookup(PDFName.of('F')).asNumber()).toBe(4 | flags);
    if (flags === 128) {
      await page.getByRole('button', { name: 'Link to another page', exact: true }).click();
      await menu.getByRole('menuitem', { name: 'Go to linked page', exact: true }).click();
      await expect(page.locator('.page-caption')).toHaveText('Page 2 of 2');
    }
  });
}

for (const operation of ['edit', 'remove'])
  test(`an imported link with an indirect subtype supports ${operation}, history, and reopening`, async ({
    page,
  }) => {
    await mockPuter(page);
    await page.goto('/#library');
    const source = await linkedPdf();
    const original = listLinks(source, 0)[0];
    const annotation = source.context.lookup(source.getPage(0).node.Annots().get(0));
    annotation.set(PDFName.of('Subtype'), source.context.register(PDFName.of('Link')));
    await openPdf(page, source);
    const target = page.locator(`[data-link-id="${original.id}"]`);
    await expect(target).toHaveAccessibleName('Link to example.com');
    if (operation === 'edit') {
      await target.click();
      const dialog = page.getByRole('dialog', { name: 'Edit link' });
      await dialog
        .getByRole('textbox', { name: 'Web address to link to' })
        .fill('example.org/updated');
      await dialog.getByRole('button', { name: 'Save link', exact: true }).click();
    } else {
      await target.click({ button: 'right' });
      await page
        .getByRole('menu')
        .getByRole('menuitem', { name: 'Remove link', exact: true })
        .click();
    }
    const expectChanged = async () => {
      await settled(page);
      if (operation === 'edit')
        await expect(target).toHaveAccessibleName('Link to example.org/updated');
      else await expect(target).toHaveCount(0);
    };
    await expectChanged();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await settled(page);
    await expect(target).toHaveAccessibleName('Link to example.com');
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expectChanged();
    const saved = await exported(page);
    const links = listLinks(saved, 0);
    if (operation === 'edit')
      expect(links[0]).toEqual({ ...original, url: 'https://example.org/updated' });
    else expect(links).toHaveLength(1);
    await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
    await openPdf(page, saved);
    await expectChanged();
    await expect(
      page.getByRole('button', { name: 'Link to another page', exact: true }),
    ).toBeVisible();
  });

// Native close() hides the dialog and returns focus before queuing its close event.
// Hold just that event so a rapid activation exercises the same scheduling window.
async function holdLinkClose(page) {
  await page.evaluate(() => {
    window.addEventListener(
      'close',
      (event) => {
        event.stopImmediatePropagation();
        window.releaseLinkClose = () => event.target.dispatchEvent(new Event('close'));
      },
      { capture: true, once: true },
    );
  });
}

for (const dismiss of ['Escape', 'Cancel', 'Save link'])
  for (const destination of ['same link', 'another link'])
    test(`${dismiss} allows reopening ${destination} while the previous close event is pending`, async ({
      page,
    }) => {
      await mockPuter(page);
      await page.goto('/#library');
      await openPdf(page, await linkedPdf());
      const web = page.getByRole('button', { name: 'Link to example.com', exact: true });
      await web.click();
      const editor = page.getByRole('dialog', { name: 'Edit link' });
      await expect(editor).toBeVisible();
      await holdLinkClose(page);
      if (dismiss === 'Escape') await page.keyboard.press('Escape');
      else await editor.getByRole('button', { name: dismiss, exact: true }).click();
      await expect.poll(() => page.evaluate(() => !!window.releaseLinkClose)).toBe(true);
      await expect(editor).toHaveCount(0);
      await expect(web).toBeFocused();
      for (let i = 0; i < 2; i++) {
        if (destination === 'same link') await page.keyboard.press('Enter');
        else await page.getByRole('button', { name: 'Link to another page', exact: true }).click();
      }
      await expect(editor).toHaveCount(0);
      await page.evaluate(() => window.releaseLinkClose());
      await expect(editor).toHaveCount(1);
      await expect(editor).toBeVisible();
      if (destination === 'same link') {
        await expect(editor.getByRole('textbox', { name: 'Web address to link to' })).toBeFocused();
        await expect(editor.getByRole('textbox', { name: 'Web address to link to' })).toHaveValue(
          'https://example.com/',
        );
      } else {
        await expect(editor.getByRole('radio', { name: 'Page in this PDF' })).toBeChecked();
        await expect(editor.getByRole('spinbutton', { name: 'Page to link to' })).toHaveValue('2');
      }
      await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    });

for (const leave of ['next page', 'library'])
  test(`a link activation awaiting a close event is cancelled when navigating to the ${leave}`, async ({
    page,
  }) => {
    await mockPuter(page);
    await page.goto('/#library');
    await openPdf(page, await linkedPdf());
    await page.getByRole('button', { name: 'Link to example.com', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Edit link' });
    await expect(editor).toBeVisible();
    await holdLinkClose(page);
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => !!window.releaseLinkClose)).toBe(true);
    await page.keyboard.press('Enter');
    await page
      .getByRole('button', {
        name: leave === 'next page' ? 'Next page' : 'Back to your PDFs',
        exact: true,
      })
      .click();
    if (leave === 'next page') {
      await expect(page.locator('.page-caption')).toHaveText('Page 2 of 2');
      await settled(page);
    } else await expect(page.getByRole('button', { name: /^Open a PDF/ })).toBeVisible();
    await page.evaluate(() => window.releaseLinkClose());
    await expect(editor).toHaveCount(0);
  });

for (const index of [0, 1])
  for (const kind of ['web', 'page'])
    test(`editing a shared ${kind} link on page ${index + 1} returns focus to that link for keyboard reopening`, async ({
      page,
    }) => {
      await mockPuter(page);
      await page.goto('/#library');
      const doc = await linkedPdf();
      doc.getPage(1).node.set(PDFName.of('Annots'), doc.getPage(0).node.Annots().clone());
      await openPdf(page, doc);
      if (index) {
        await page.getByRole('button', { name: 'Next page', exact: true }).click();
        await expect(page.locator('.page-caption')).toHaveText('Page 2 of 2');
        await settled(page);
      }
      await page
        .getByRole('button', {
          name: kind === 'web' ? 'Link to example.com' : 'Link to another page',
          exact: true,
        })
        .click();
      const editor = page.getByRole('dialog', { name: 'Edit link' });
      await editor
        .getByRole('textbox', { name: 'Web address to link to' })
        .fill('example.org/updated');
      await editor.getByRole('button', { name: 'Save link', exact: true }).click();
      await expect(editor).toHaveCount(0);
      await settled(page);
      const edited = page.getByRole('button', { name: 'Link to example.org/updated', exact: true });
      await expect(edited).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(editor).toBeVisible();
      await expect(editor.getByRole('textbox', { name: 'Web address to link to' })).toHaveValue(
        'https://example.org/updated',
      );
      await page.keyboard.press('Escape');
      await expect(editor).toHaveCount(0);
      await expect(edited).toBeFocused();
      const saved = await exported(page);
      const position = kind === 'web' ? 0 : 1;
      expect(listLinks(saved, index)[position].url).toBe('https://example.org/updated');
      expect(listLinks(saved, 1 - index)[position].url).toBe(
        kind === 'web' ? 'https://example.com/' : null,
      );
    });
