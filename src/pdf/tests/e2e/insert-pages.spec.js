import { clickAway } from './editing-helpers.js';
import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { addNote, listNotes } from '../../src/core/notes.js';

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
    for (const title of ['Page', 'File', 'Edit', 'View', 'Insert']) {
      await bar.getByRole('menuitem', { name: title, exact: true }).click();
      if (await item.count()) return item.click();
      await page.keyboard.press('Escape');
    }
  } else {
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    if (await item.count()) return item.click();
    for (const section of ['Page', 'Edit', 'View', 'Insert']) {
      await page.getByRole('menu').getByRole('menuitem', { name: section, exact: true }).click();
      if (await item.count()) return item.click();
      await page.keyboard.press('Escape');
    }
  }
  throw new Error(`No menu item named ${name}`);
}
const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
async function pagesOf(widths) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  widths.forEach((width, i) =>
    doc.addPage([width, 300]).drawText(`Width ${width}`, { x: 20, y: 250, size: 14, font }),
  );
  return doc;
}

async function layeredPage(green = false) {
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([200, 200]);
  const ctx = doc.context;
  const group = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('Hidden') }));
  doc.catalog.set(PDFName.of('OCProperties'), ctx.obj({ OCGs: [group], D: { OFF: [group] } }));
  sheet.node.set(PDFName.of('Resources'), ctx.obj({ Properties: { Hidden: group } }));
  sheet.node.set(
    PDFName.of('Contents'),
    ctx.register(
      ctx.flateStream(
        `${green ? '0 1 0 rg 0 0 200 200 re f' : ''} /OC /Hidden BDC 1 0 0 rg 0 0 200 200 re f EMC`,
      ),
    ),
  );
  return doc;
}

const centerPixel = (page) =>
  page
    .locator('.paper > canvas')
    .first()
    .evaluate((canvas) =>
      Array.from(
        canvas.getContext('2d').getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data,
      ),
    );

test('Insert pages from PDF puts a chosen range after the current page and can go first or last', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await pagesOf([300, 300]));
  const other = Buffer.from(await (await pagesOf([401, 402, 403])).save());
  const chooser = page.waitForEvent('filechooser');
  await menu(page, 'Insert pages from PDF…');
  await (await chooser).setFiles({ name: 'other.pdf', mimeType: 'application/pdf', buffer: other });
  const dialog = page.getByRole('dialog', { name: 'Insert pages' });
  await expect(dialog).toContainText('other.pdf has 3 pages');
  await expect(dialog.getByRole('radio', { name: 'All pages (3)' })).toBeChecked();
  await expect(dialog.getByRole('radio', { name: 'After page 1', exact: true })).toBeChecked();
  await dialog.getByLabel('Pages of the other PDF').fill('3, 1');
  await expect(dialog.getByRole('radio', { name: 'Pages', exact: true })).toBeChecked();
  await dialog.getByRole('button', { name: 'Insert pages', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#toast')).toHaveText('2 pages inserted after page 1.');
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 4');
  await settled(page);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const merged = await PDFDocument.load(await readFile(await (await pending).path()));
  expect(merged.getPages().map((p) => Math.round(p.getWidth()))).toEqual([300, 403, 401, 300]);
  // Everything at the beginning, then undo.
  const again = page.waitForEvent('filechooser');
  await menu(page, 'Insert pages from PDF…');
  await (await again).setFiles({ name: 'other.pdf', mimeType: 'application/pdf', buffer: other });
  const second = page.getByRole('dialog', { name: 'Insert pages' });
  await second.getByRole('radio', { name: 'At the beginning', exact: true }).check();
  await second.getByRole('button', { name: 'Insert pages', exact: true }).click();
  await expect(page.locator('#toast')).toHaveText('3 pages inserted at the beginning.');
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 7');
  await settled(page);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText(/of 4$/);
});

test('Duplicate page copies the current page right after it', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await pagesOf([300, 500]));
  await menu(page, 'Duplicate page');
  await expect(page.locator('#toast')).toHaveText('Page duplicated.');
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 3');
  await settled(page);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const doc = await PDFDocument.load(await readFile(await (await pending).path()));
  expect(doc.getPages().map((p) => Math.round(p.getWidth()))).toEqual([300, 300, 500]);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText(/of 2$/);
});

test('inserting an unresolved named link cannot target an unrelated existing page', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const target = await pagesOf([300]),
    source = await pagesOf([400]),
    n = PDFName.of;
  target.catalog.set(n('Dests'), target.context.obj({ chapter: [target.getPage(0).ref, 'Fit'] }));
  for (const doc of [target, source])
    doc.getPage(0).node.addAnnot(
      doc.context.register(
        doc.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [20, 20, 100, 40],
          Dest: PDFString.of('chapter'),
        }),
      ),
    );
  await openPdf(page, target);
  const jump = page.getByRole('button', { name: /^Link to (another page|page \d+)$/ });
  await expect(jump).toBeVisible();
  const chooser = page.waitForEvent('filechooser');
  await menu(page, 'Insert pages from PDF…');
  await (
    await chooser
  ).setFiles({
    name: 'unresolved.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await source.save()),
  });
  await page
    .getByRole('dialog', { name: 'Insert pages' })
    .getByRole('button', { name: 'Insert pages', exact: true })
    .click();
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 2');
  await settled(page);
  await expect(jump).toHaveCount(0);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = await PDFDocument.load(await readFile(await (await pending).path()));
  expect(saved.context.lookup(saved.getPage(1).node.Annots().get(0)).has(n('Dest'))).toBe(false);
  await page.getByRole('button', { name: 'Previous page', exact: true }).click();
  await expect(jump).toBeVisible();
  await jump.click();
  await page
    .getByRole('dialog', { name: 'Edit link' })
    .getByRole('button', { name: 'Go to linked page' })
    .click();
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await expect(jump).toBeVisible();
});

test('Duplicate page preserves page events and chained destinations in the download', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const source = await pagesOf([300, 500]),
    ctx = source.context,
    n = PDFName.of;
  source.catalog.set(n('Dests'), ctx.obj({ last: [source.getPage(1).ref, 'Fit'] }));
  source.getPage(0).node.set(n('AA'), ctx.obj({ O: { S: 'GoTo', D: n('last') } }));
  source.getPage(0).node.addAnnot(
    ctx.register(
      ctx.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [20, 20, 100, 40],
        A: {
          S: 'URI',
          URI: PDFString.of('https://example.com'),
          Next: { S: 'GoTo', D: PDFString.of('last') },
        },
      }),
    ),
  );
  await openPdf(page, source);
  await menu(page, 'Duplicate page');
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 3');
  await settled(page);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = await PDFDocument.load(await readFile(await (await pending).path()));
  for (const index of [0, 1]) {
    const node = saved.getPage(index).node;
    expect(node.lookup(n('AA')).lookup(n('O')).lookup(n('D')).get(0)).toBe(saved.getPage(2).ref);
    const annot = saved.context.lookup(node.Annots().get(0));
    expect(annot.lookup(n('A')).lookup(n('Next')).lookup(n('D')).get(0)).toBe(saved.getPage(2).ref);
  }
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText(/of 2$/);
});

test('Duplicate page keeps hidden layers hidden through download and undo', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  const center = () => centerPixel(page);
  await openPdf(page, await layeredPage());
  await settled(page);
  await expect.poll(center).toEqual([255, 255, 255, 255]);
  await menu(page, 'Duplicate page');
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 2');
  await settled(page);
  await expect.poll(center).toEqual([255, 255, 255, 255]);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = await PDFDocument.load(await readFile(await (await pending).path()));
  const groups = saved.catalog.lookup(PDFName.of('OCProperties')).lookup(PDFName.of('OCGs'));
  expect(groups.size()).toBe(1);
  expect(
    saved.getPage(1).node.Resources().lookup(PDFName.of('Properties')).get(PDFName.of('Hidden')),
  ).toBe(groups.get(0));
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);
  await expect.poll(center).toEqual([255, 255, 255, 255]);
});

test('inserting pages preserves the existing and incoming layer visibility', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await layeredPage());
  await settled(page);
  await expect.poll(() => centerPixel(page)).toEqual([255, 255, 255, 255]);
  const chooser = page.waitForEvent('filechooser');
  await menu(page, 'Insert pages from PDF…');
  await (
    await chooser
  ).setFiles({
    name: 'layers.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await (await layeredPage(true)).save()),
  });
  const dialog = page.getByRole('dialog', { name: 'Insert pages' });
  await dialog.getByRole('button', { name: 'Insert pages', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 2');
  await settled(page);
  await expect.poll(() => centerPixel(page)).toEqual([0, 255, 0, 255]);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = await PDFDocument.load(await readFile(await (await pending).path()));
  const props = saved.catalog.lookup(PDFName.of('OCProperties'));
  expect(props.lookup(PDFName.of('OCGs')).size()).toBe(2);
  expect(props.lookup(PDFName.of('D')).lookup(PDFName.of('OFF')).size()).toBe(2);
  await page.getByRole('button', { name: 'Previous page', exact: true }).click();
  await settled(page);
  await expect.poll(() => centerPixel(page)).toEqual([255, 255, 255, 255]);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);
  await expect.poll(() => centerPixel(page)).toEqual([255, 255, 255, 255]);
});

test('inserting the same page twice gives each copy independently editable notes', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await pagesOf([300]));
  const source = await pagesOf([300]);
  addNote(source, 0, { x: 50, y: 230, text: 'Original note' });
  const chooser = page.waitForEvent('filechooser');
  await menu(page, 'Insert pages from PDF…');
  await (
    await chooser
  ).setFiles({
    name: 'notes.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await source.save()),
  });
  const dialog = page.getByRole('dialog', { name: 'Insert pages' });
  await dialog.getByLabel('Pages of the other PDF').fill('1, 1');
  await dialog.getByRole('button', { name: 'Insert pages', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 3');
  await settled(page);
  await page.getByRole('button', { name: 'Edit note: Original note', exact: true }).click();
  const editor = page.getByRole('group', { name: 'Edit note' });
  await editor.getByLabel('Note text').fill('First copy only');
  await clickAway(page);
  await settled(page);
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 3 of 3');
  await expect(
    page.getByRole('button', { name: 'Edit note: Original note', exact: true }),
  ).toBeVisible();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = await PDFDocument.load(await readFile(await (await pending).path()));
  expect(saved.getPages().map((_, i) => listNotes(saved, i).map((note) => note.text))).toEqual([
    [],
    ['First copy only'],
    ['Original note'],
  ]);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await settled(page);
  await page.getByRole('button', { name: 'Previous page', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Edit note: Original note', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Edit note: First copy only', exact: true }),
  ).toBeVisible();
});

async function pendingInsertion(page) {
  await mockPuter(page);
  await page.goto('/#library');
  const target = await pagesOf([300]);
  const field = target.getForm().createTextField('Name');
  field.setText('Original');
  field.addToPage(target.getPage(0), { x: 20, y: 100, width: 200, height: 30 });
  await openPdf(page, target);
  await page.evaluate(() => {
    const read = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = async function () {
      const bytes = await read.call(this);
      File.prototype.arrayBuffer = read;
      return new Promise((resolve) => {
        window.releaseSourceRead = () => resolve(bytes);
      });
    };
  });
  const chooser = page.waitForEvent('filechooser');
  await menu(page, 'Insert pages from PDF…');
  await (
    await chooser
  ).setFiles({
    name: 'other.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await (await pagesOf([400])).save()),
  });
  await expect.poll(() => page.evaluate(() => !!window.releaseSourceRead)).toBe(true);
  await page
    .getByRole('textbox', { name: 'Name (on page)', exact: true })
    .fill('Updated while reading');
  await page.evaluate(() => window.releaseSourceRead());
  const dialog = page.getByRole('dialog', { name: 'Insert pages' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('inserting pages preserves a form draft entered while the source file is being read', async ({
  page,
}) => {
  const dialog = await pendingInsertion(page);
  await dialog.getByRole('button', { name: 'Insert pages', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 2');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const exported = await PDFDocument.load(await readFile(await (await pending).path()));
  expect(exported.getForm().getTextField('Name').getText()).toBe('Updated while reading');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await expect(page.getByLabel('Name (on page)', { exact: true })).toHaveValue(
    'Updated while reading',
  );
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByLabel('Name (on page)', { exact: true })).toHaveValue('Original');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.getByLabel('Name (on page)', { exact: true })).toHaveValue(
    'Updated while reading',
  );
  // Redo takes the reader to the inserted page again, as the insertion did.
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 2');
  await page.getByRole('button', { name: 'Previous page', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
  await expect(page.getByLabel('Name (on page)', { exact: true })).toHaveValue(
    'Updated while reading',
  );
});

for (const cancel of [false, true])
  test(`insertion ${cancel ? 'can cancel' : 'ignores repeated submissions'} while the existing draft is committing`, async ({
    page,
  }) => {
    const dialog = await pendingInsertion(page);
    await page.evaluate(async () => {
      const { PdfSession } = await import('/src/core/document.js');
      const change = PdfSession.prototype.change;
      window.insertionChanges = 0;
      PdfSession.prototype.change = async function (...args) {
        window.insertionChanges++;
        const result = await change.apply(this, args);
        if (window.insertionChanges === 1)
          await new Promise((resolve) => {
            window.releaseInsertionDraft = resolve;
          });
        return result;
      };
    });
    await dialog.getByRole('button', { name: 'Insert pages', exact: true }).click();
    await expect.poll(() => page.evaluate(() => !!window.releaseInsertionDraft)).toBe(true);
    await expect(dialog.getByRole('button', { name: 'Insert pages', exact: true })).toBeDisabled();
    await dialog.locator('form').evaluate((form) => form.requestSubmit());
    if (cancel) await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.evaluate(() => window.releaseInsertionDraft());
    await expect(dialog).toHaveCount(0);
    await settled(page);
    await expect(page.locator('.page-caption')).toHaveText(cancel ? 'Page 1 of 1' : 'Page 2 of 2');
    expect(await page.evaluate(() => window.insertionChanges)).toBe(cancel ? 1 : 2);
    if (!cancel) await page.getByRole('button', { name: 'Previous page', exact: true }).click();
    await expect(page.getByLabel('Name (on page)', { exact: true })).toHaveValue(
      'Updated while reading',
    );
  });

test('opening page insertion parses an ordinary source PDF only once', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await pagesOf([300]));
  const bytes = Buffer.from(
    await (await pagesOf(Array.from({ length: 100 }, (_, i) => 401 + i))).save(),
  );
  await page.evaluate(async (size) => {
    const moduleUrl = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((url) => /\/pdf-lib\.js(?:\?|$)/.test(url));
    if (!moduleUrl) throw new Error('The loaded pdf-lib module was not found.');
    const { PDFDocument } = await import(moduleUrl);
    const load = PDFDocument.load;
    window.sourceParses = 0;
    PDFDocument.load = function (data, ...args) {
      if (data.byteLength === size) window.sourceParses++;
      return load.call(this, data, ...args);
    };
  }, bytes.length);
  const chooser = page.waitForEvent('filechooser');
  await menu(page, 'Insert pages from PDF…');
  await (
    await chooser
  ).setFiles({ name: 'source.pdf', mimeType: 'application/pdf', buffer: bytes });
  const dialog = page.getByRole('dialog', { name: 'Insert pages', exact: true });
  await expect(dialog).toContainText('source.pdf has 100 pages');
  expect(await page.evaluate(() => window.sourceParses)).toBe(1);
  await dialog.getByLabel('Pages of the other PDF').fill('100, 1');
  await dialog.getByRole('button', { name: 'Insert pages', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 3');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const result = await PDFDocument.load(await readFile(await (await pending).path()));
  expect(result.getPages().map((sheet) => sheet.getWidth())).toEqual([300, 500, 401]);
});

for (const next of ['library', 'new PDF'])
  test(`closing the destination before a source read finishes stops parsing in the ${next}`, async ({
    page,
  }) => {
    await mockPuter(page);
    await page.goto('/#library');
    await openPdf(page, await pagesOf([300]));
    const bytes = Buffer.from(await (await pagesOf([401, 402])).save());
    await page.evaluate(async (size) => {
      const moduleUrl = performance
        .getEntriesByType('resource')
        .map((entry) => entry.name)
        .find((url) => /\/pdf-lib\.js(?:\?|$)/.test(url));
      if (!moduleUrl) throw new Error('The loaded pdf-lib module was not found.');
      const { PDFDocument } = await import(moduleUrl);
      const load = PDFDocument.load;
      window.sourceParses = 0;
      PDFDocument.load = function (data, ...args) {
        if (data.byteLength === size) window.sourceParses++;
        return load.call(this, data, ...args);
      };
      const read = File.prototype.arrayBuffer;
      File.prototype.arrayBuffer = async function () {
        File.prototype.arrayBuffer = read;
        const data = await read.call(this);
        return new Promise((resolve) => {
          window.releaseSourceRead = () => resolve(data);
        });
      };
    }, bytes.length);
    const file = { name: 'source.pdf', mimeType: 'application/pdf', buffer: bytes };
    const choosing = page.waitForEvent('filechooser');
    await menu(page, 'Insert pages from PDF…');
    await (await choosing).setFiles(file);
    await expect.poll(() => page.evaluate(() => !!window.releaseSourceRead)).toBe(true);
    await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
    const newPdf = page.getByRole('button', { name: 'New blank PDF', exact: true });
    await expect(newPdf).toBeVisible();
    if (next === 'new PDF') {
      await newPdf.click();
      await settled(page);
    }
    await page.evaluate(async () => {
      window.releaseSourceRead();
      // A resumed read starts validation in its microtask, before the next paint.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    expect(await page.evaluate(() => window.sourceParses)).toBe(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    if (next === 'library') await newPdf.click();
    await settled(page);
    const retry = page.waitForEvent('filechooser');
    await menu(page, 'Insert pages from PDF…');
    await (await retry).setFiles(file);
    const dialog = page.getByRole('dialog', { name: 'Insert pages', exact: true });
    await expect(dialog).toContainText('source.pdf has 2 pages');
    expect(await page.evaluate(() => window.sourceParses)).toBe(1);
    await dialog.getByRole('button', { name: 'Insert pages', exact: true }).click();
    await expect(page.locator('.page-caption')).toHaveText('Page 2 of 3');
  });
