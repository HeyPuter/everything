import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { createCanvas } from '@napi-rs/canvas';
import { padJpegHeaders } from '../fixtures/jpeg-padding.js';
import { MAX_IMAGE_SIZE } from '../../src/core/document.js';
import { addBookmark } from '../../src/core/outline-edit.js';

const PUTER_MOCK = `window.puter = { env: 'web', auth: { isSignedIn: () => true, getUser: async () => ({username:'test-user'}), signIn: async () => {}, signOut: async () => {} }, fs: { readdir: async () => [], write: async () => ({}) }, ui: { onLaunchedWithItems: () => {}, onItemsOpened: () => {} } };`;
async function mockPuter(page) {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
  );
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
async function picture(name, width, height, fill) {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = fill;
  context.fillRect(0, 0, width, height);
  const png = name.endsWith('.png');
  return {
    name,
    mimeType: png ? 'image/png' : 'image/jpeg',
    buffer: await (png ? canvas.encode('png') : canvas.encode('jpeg', 90)),
  };
}
async function downloaded(page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  return PDFDocument.load(await readFile(await (await pending).path()));
}
const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

test('image page insertion preserves link and bookmark targets through history and reopening', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([400, 500]);
  doc.addPage([500, 400]).drawText('Destination page', { x: 40, y: 300, size: 18 });
  const destination = doc.context.register(doc.context.obj([1, 'Fit']));
  doc.getPage(0).node.addAnnot(
    doc.context.register(
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [40, 350, 200, 390],
        Dest: destination,
      }),
    ),
  );
  addBookmark(doc, { title: 'Destination', pageIndex: 1 });
  doc.catalog
    .lookup(PDFName.of('Outlines'))
    .lookup(PDFName.of('First'))
    .set(PDFName.of('Dest'), destination);
  const open = async (pdf) => {
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('ControlOrMeta+o');
    await (
      await chooser
    ).setFiles({
      name: 'linked.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(await pdf.save()),
    });
    await expect(page.locator('.page-caption')).toHaveText(`Page 1 of ${pdf.getPageCount()}`);
  };
  const goToFirst = async () => {
    await page.getByLabel('Page number', { exact: true }).fill('1');
    await page.getByLabel('Page number', { exact: true }).press('Enter');
    await expect(page.locator('.page-caption')).toContainText('Page 1 of');
  };
  const followLink = async (total) => {
    await goToFirst();
    await page.getByRole('button', { name: 'Link to another page', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Edit link' })
      .getByRole('button', { name: 'Go to linked page', exact: true })
      .click();
    await expect(page.locator('.page-caption')).toHaveText(`Page ${total} of ${total}`);
    await expect(
      page.getByRole('button', { name: 'Edit text: Destination page', exact: true }),
    ).toBeEnabled();
  };
  await open(doc);
  const chooser = page.waitForEvent('filechooser');
  await menu(page, 'Insert pictures as pages…');
  await (
    await chooser
  ).setFiles([
    await picture('landscape.png', 100, 60, '#111111'),
    await picture('portrait.png', 60, 100, '#222222'),
  ]);
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 4');
  await settled(page);
  await followLink(4);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await settled(page);
  await followLink(2);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await settled(page);
  await followLink(4);
  const saved = await downloaded(page);
  await open(saved);
  await followLink(4);
  await goToFirst();
  if (!(await page.locator('#page-sidebar').isVisible()))
    await page.getByRole('button', { name: 'Toggle pages panel', exact: true }).click();
  await page.getByRole('tab', { name: 'Outline', exact: true }).click();
  await page.getByRole('treeitem', { name: 'Destination', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 4 of 4');
  await expect(
    page.getByRole('button', { name: 'Edit text: Destination page', exact: true }),
  ).toBeEnabled();
});

for (const padded of [false, true])
  test(`Pictures to PDF turns chosen pictures into pages turned to match them (padded JPEG=${padded})`, async ({
    page,
  }) => {
    await mockPuter(page);
    await page.goto('/#library');
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Pictures to PDF', exact: true }).click();
    const picker = await chooser;
    expect(picker.isMultiple()).toBe(true);
    const photo = await picture('holiday.jpg', 400, 300, '#d02020');
    if (padded) photo.buffer = padJpegHeaders(photo.buffer);
    await picker.setFiles([photo, await picture('portrait.png', 300, 400, '#2040d0')]);
    await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
    await expect(page.locator('.document-name')).toHaveText('holiday');
    await settled(page);
    const doc = await downloaded(page);
    const [first, second] = doc.getPages().map((p) => p.getSize());
    expect(first.width).toBeGreaterThan(first.height);
    expect(second.height).toBeGreaterThan(second.width);
    expect(Math.round(first.width)).toBe(Math.round(second.height));
  });

test('the Page menu inserts pictures after the current page and the open command accepts them', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/');
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  const chooser = page.waitForEvent('filechooser');
  await menu(page, 'Insert pictures as pages…');
  await (
    await chooser
  ).setFiles([
    await picture('a.png', 100, 80, '#111111'),
    await picture('b.png', 80, 100, '#222222'),
  ]);
  await expect(page.locator('#toast')).toHaveText('2 pictures added as pages.');
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 3');
  await settled(page);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText(/Page \d of 1/);
  await settled(page);
  const open = page.waitForEvent('filechooser');
  await menu(page, 'Open…');
  await (await open).setFiles([await picture('scan.jpg', 600, 800, '#808080')]);
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await expect(page.locator('.document-name')).toHaveText('scan');
});

test('pictures dropped onto the app become a new PDF', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/');
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  const files = [
    await picture('one.png', 200, 100, '#101010'),
    await picture('two.png', 100, 200, '#202020'),
  ];
  const opened = await page.evaluate(
    async (payload) => {
      const box = document.querySelector('canvas').getBoundingClientRect();
      const x = box.left + box.width / 2,
        y = box.top + box.height / 2;
      const target = document.elementFromPoint(x, y);
      const send = (type, withFiles) => {
        const transfer = new DataTransfer();
        if (withFiles)
          for (const file of payload)
            transfer.items.add(
              new File([Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0))], file.name, {
                type: file.mimeType,
              }),
            );
        else transfer.items.add('', 'Files');
        const event = new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
          clientX: x,
          clientY: y,
        });
        target.dispatchEvent(event);
        return event.defaultPrevented;
      };
      send('dragenter', false);
      send('dragover', false);
      return send('drop', true);
    },
    files.map((f) => ({ name: f.name, mimeType: f.mimeType, base64: f.buffer.toString('base64') })),
  );
  expect(opened).toBe(true);
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
  await expect(page.locator('.document-name')).toHaveText('one');
});

test('oversized rotated photos are rejected before decoding and a smaller photo still opens upright', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/');
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  const jpeg = await picture('photo.jpg', 400, 300, '#d02020');
  const exif = Buffer.from(
    'ffe1002245786966000049492a0008000000010012010300010000000600000000000000',
    'hex',
  );
  const bytes = Buffer.concat([jpeg.buffer.subarray(0, 2), exif, jpeg.buffer.subarray(2)]);
  await page.evaluate(
    ({ base64, limit }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const file = new File([bytes, new Uint8Array(limit + 1 - bytes.length)], 'large.jpg', {
        type: 'image/jpeg',
      });
      const read = File.prototype.arrayBuffer;
      window.pictureReads = 0;
      File.prototype.arrayBuffer = function () {
        window.pictureReads++;
        return read.call(this);
      };
      const transfer = new DataTransfer();
      transfer.items.add(file);
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, cancelable: true }));
    },
    { base64: bytes.toString('base64'), limit: MAX_IMAGE_SIZE },
  );
  await expect(page.locator('#toast')).toHaveText('Choose an image smaller than 20 MB.');
  expect(await page.evaluate(() => window.pictureReads)).toBe(0);
  await expect(page).toHaveTitle('Untitled.pdf · PDF Editor');
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (await chooser).setFiles({ name: 'photo.jpg', mimeType: 'image/jpeg', buffer: bytes });
  // The new PDF made from the photo is not saved anywhere yet.
  await expect(page).toHaveTitle('* photo.pdf · PDF Editor');
  await settled(page);
  const { width, height } = (await downloaded(page)).getPage(0).getSize();
  expect(height).toBeGreaterThan(width);
});

for (const source of ['new PDF', 'existing PDF'])
  test(`an image batch exceeding the page capacity of a ${source} is rejected before reading files`, async ({
    page,
  }) => {
    await mockPuter(page);
    await page.goto('/#library');
    if (source === 'existing PDF') {
      const doc = await PDFDocument.create();
      for (let i = 0; i < 999; i++) doc.addPage([200, 200]);
      const chooser = page.waitForEvent('filechooser');
      await page.getByRole('button', { name: /^Open a PDF/ }).click();
      await (
        await chooser
      ).setFiles({
        name: 'many-pages.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from(await doc.save()),
      });
      await expect(page.locator('.page-caption')).toHaveText('Page 1 of 999');
      await settled(page);
    }
    await page.evaluate(() => {
      const read = File.prototype.arrayBuffer;
      window.imagePageReads = 0;
      File.prototype.arrayBuffer = function () {
        window.imagePageReads++;
        return read.call(this);
      };
    });
    const image = await picture('picture.png', 4, 4, '#2040d0');
    const select = async (files) => {
      const chooser = page.waitForEvent('filechooser');
      if (source === 'new PDF')
        await page.getByRole('button', { name: 'Pictures to PDF', exact: true }).click();
      else await menu(page, 'Insert pictures as pages…');
      await (await chooser).setFiles(files);
    };
    await select(
      Array.from({ length: source === 'new PDF' ? 1001 : 2 }, (_, i) => ({
        ...image,
        name: `picture-${i}.png`,
      })),
    );
    await expect(page.locator('#toast')).toHaveText('Keep between 1 and 1,000 pages in the PDF.');
    expect(await page.evaluate(() => window.imagePageReads)).toBe(0);
    if (source === 'existing PDF') {
      await expect(page.locator('.page-caption')).toHaveText('Page 1 of 999');
      await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    }
    await select([image]);
    await expect(page.locator('.page-caption')).toHaveText(
      source === 'new PDF' ? 'Page 1 of 1' : 'Page 2 of 1000',
    );
    await settled(page);
    expect(await page.evaluate(() => window.imagePageReads)).toBe(1);
  });
