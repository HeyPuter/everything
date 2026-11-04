import { test, expect } from '@playwright/test';
import {
  PDFDocument,
  PDFName,
  PDFString,
  StandardFonts,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
} from 'pdf-lib';

const PUTER_MOCK = `window.puter = { env: 'web', auth: { isSignedIn: () => true, getUser: async () => ({username:'test-user'}), signIn: async () => {}, signOut: async () => {} }, fs: { readdir: async () => [], write: async () => ({}) }, ui: { onLaunchedWithItems: () => {}, onItemsOpened: () => {} } };`;
async function mockPuter(page) {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
  );
}
async function openPdf(page, doc, name = 'test.pdf') {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(await doc.save()) });
  await expect(page.locator('.page-caption')).toHaveText(`Page 1 of ${doc.getPageCount()}`);
}
async function mixedPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const [i, size] of [
    [400, 500],
    [500, 300],
    [400, 500],
  ].entries())
    doc.addPage(size).drawText(`Sheet ${i + 1}`, { x: 40, y: 200, size: 24, font });
  return doc;
}
/** Record what the page looked like at the moment the browser would have printed it. */
async function stubPrint(page) {
  await page.addInitScript(() => {
    window.printed = [];
    window.print = () => {
      const sheets = [...document.querySelectorAll('.print-sheet')];
      window.printed.push({
        sheets: sheets.map((sheet) => ({
          landscape: sheet.classList.contains('landscape'),
          alt: sheet.querySelector('img').alt,
          width: sheet.querySelector('img').naturalWidth,
          height: sheet.querySelector('img').naturalHeight,
        })),
        app: getComputedStyle(document.querySelector('#app')).display,
        sheetsShown: getComputedStyle(document.querySelector('.print-sheets')).display,
        firstSheet: getComputedStyle(sheets[0]).breakBefore,
        secondSheet: sheets[1] ? getComputedStyle(sheets[1]).breakBefore : null,
        margin: getComputedStyle(document.querySelector('.print-sheet')).height,
        heights: sheets.map((sheet) => getComputedStyle(sheet).height),
        viewport: [window.innerWidth, window.innerHeight],
      });
      window.dispatchEvent(new Event('afterprint'));
    };
  });
}

test('Print sends every page to the browser at printer resolution, one per sheet', async ({
  page,
}) => {
  await mockPuter(page);
  await stubPrint(page);
  await page.goto('/#library');
  await openPdf(page, await mixedPdf());
  await page.keyboard.press('ControlOrMeta+p');
  const dialog = page.getByRole('dialog', { name: 'Print' });
  await expect(dialog.getByLabel('All pages (3)')).toBeChecked();
  // Operate the dialog in screen media, then inspect the prepared sheets in print media.
  // Hold the first encoded page so the media switch finishes before window.print runs.
  await page.evaluate(() => {
    const encode = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback, type, ...args) {
      if (type !== 'image/jpeg') return encode.call(this, callback, type, ...args);
      HTMLCanvasElement.prototype.toBlob = encode;
      return encode.call(
        this,
        (blob) => {
          window.releasePrintImage = () => callback(blob);
        },
        type,
        ...args,
      );
    };
  });
  await dialog.getByRole('button', { name: 'Print', exact: true }).click();
  await expect.poll(() => page.evaluate(() => !!window.releasePrintImage)).toBe(true);
  await page.emulateMedia({ media: 'print' });
  await page.evaluate(() => window.releasePrintImage());
  await expect.poll(() => page.evaluate(() => window.printed.length)).toBe(1);
  const printed = await page.evaluate(() => window.printed[0]);
  expect(printed.sheets.map((sheet) => sheet.alt)).toEqual(['Page 1', 'Page 2', 'Page 3']);
  expect(printed.sheets.map((sheet) => sheet.landscape)).toEqual([false, true, false]);
  // 200 dpi: 400 pt wide pages come out at 1112 pixels.
  expect(printed.sheets[0].width).toBe(Math.ceil((400 * 200) / 72));
  expect(printed.sheets[1].width).toBe(Math.ceil((500 * 200) / 72));
  // Only the sheets are visible on paper, each starting a new page.
  expect(printed.app).toBe('none');
  expect(printed.sheetsShown).toBe('block');
  expect(printed.secondSheet).toBe('page');
  // Viewport units follow the first page's box on paper, so a portrait sheet is as tall as
  // the longer side and a landscape one as the shorter; a landscape sheet as tall as a
  // portrait one would spill onto a blank page.
  const [long, short] = [Math.max(...printed.viewport), Math.min(...printed.viewport)];
  expect(printed.heights).toEqual([`${long}px`, `${short}px`, `${long}px`]);
  // Everything is cleaned up afterwards and the editor is usable again.
  await expect(page.locator('.print-sheets')).toHaveCount(0);
  await expect(page.locator('body')).not.toHaveClass(/printing/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await page.emulateMedia({ media: 'screen' });
  await expect(page.getByRole('toolbar')).toBeVisible();
});

test('a print image that cannot decode stops printing, releases resources, and allows retry', async ({
  page,
}) => {
  await mockPuter(page);
  await stubPrint(page);
  await page.addInitScript(() => {
    const decode = HTMLImageElement.prototype.decode;
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    window.printImageUrls = [];
    window.revokedPrintUrls = [];
    URL.createObjectURL = (blob) => {
      const url = create(blob);
      if (blob.type === 'image/jpeg') window.printImageUrls.push(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      window.revokedPrintUrls.push(url);
      revoke(url);
    };
    HTMLImageElement.prototype.decode = function () {
      if (window.failPrintImage && this.closest('.print-sheet')) {
        window.failPrintImage = false;
        this.src = 'data:image/jpeg;base64,YnJva2Vu';
      }
      return decode.call(this);
    };
  });
  await page.goto('/#library');
  await openPdf(page, await mixedPdf());
  await page.evaluate(() => {
    window.failPrintImage = true;
  });
  const print = async () => {
    await page.keyboard.press('ControlOrMeta+p');
    await page
      .getByRole('dialog', { name: 'Print', exact: true })
      .getByRole('button', { name: 'Print', exact: true })
      .click();
  };
  await print();
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  expect(await page.evaluate(() => window.printed)).toEqual([]);
  await expect(page.locator('#toast')).toHaveText(
    'Page 1 could not be prepared for printing. Please try again.',
  );
  await expect(page.locator('.print-sheets')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => window.printImageUrls.length)).toBe(1);
  expect(
    await page.evaluate(() =>
      window.printImageUrls.every((url) => window.revokedPrintUrls.includes(url)),
    ),
  ).toBe(true);
  await print();
  await expect.poll(() => page.evaluate(() => window.printed.length)).toBe(1);
  expect(
    await page.evaluate(() => window.printed[0].sheets.every((sheet) => sheet.width > 0)),
  ).toBe(true);
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
});

test('Print offers the current page and a typed range, and explains a bad range', async ({
  page,
}) => {
  await mockPuter(page);
  await stubPrint(page);
  await page.goto('/#library');
  await openPdf(page, await mixedPdf());
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 3');
  await page.keyboard.press('ControlOrMeta+p');
  const dialog = page.getByRole('dialog', { name: 'Print' });
  await dialog.getByLabel('Current page (2)').check();
  await dialog.getByRole('button', { name: 'Print', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.printed.length)).toBe(1);
  expect(await page.evaluate(() => window.printed[0].sheets.map((s) => s.alt))).toEqual(['Page 2']);
  await page.keyboard.press('ControlOrMeta+p');
  await dialog.getByLabel('Page range', { exact: true }).fill('3-1');
  await expect(dialog.getByLabel('Pages', { exact: true })).toBeChecked();
  await dialog.getByRole('button', { name: 'Print', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.printed.length)).toBe(2);
  expect(await page.evaluate(() => window.printed[1].sheets.map((s) => s.alt))).toEqual([
    'Page 3',
    'Page 2',
    'Page 1',
  ]);
  await page.keyboard.press('ControlOrMeta+p');
  await dialog.getByLabel('Page range', { exact: true }).fill('0');
  await dialog.getByRole('button', { name: 'Print', exact: true }).click();
  await expect(dialog.locator('.dialog-error')).toHaveText('Pages must be between 1 and 3.');
  await expect(dialog).toBeVisible();
});

test('a print in preparation can be cancelled and leaves nothing behind', async ({ page }) => {
  await mockPuter(page);
  await stubPrint(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  for (let i = 0; i < 12; i++) doc.addPage([600, 800]);
  await openPdf(page, doc);
  await page.keyboard.press('ControlOrMeta+p');
  await page
    .getByRole('dialog', { name: 'Print' })
    .getByRole('button', { name: 'Print', exact: true })
    .click();
  const progress = page.getByRole('dialog', { name: 'Printing' });
  await expect(progress).toBeVisible();
  await progress.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.print-sheets')).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.printed.length)).toBe(0);
  // The editor works normally afterwards.
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 12');
});

for (const kind of ['annotation flags', 'layer usage']) {
  test(`printing respects ${kind} independently of screen visibility`, async ({ page }) => {
    await mockPuter(page);
    await page.addInitScript(() => {
      window.printedColors = null;
      window.print = () => {
        const image = document.querySelector('.print-sheet img');
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 200;
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0, 200, 200);
        window.printedColors = [30, 70, 110, 150].map(
          (x) => context.getImageData(x, 100, 1, 1).data[1],
        );
        window.dispatchEvent(new Event('afterprint'));
      };
    });
    await page.goto('/#library');
    const doc = await PDFDocument.create();
    const sheet = doc.addPage([200, 200]);
    const ctx = doc.context;
    if (kind === 'annotation flags') {
      for (const [i, flags] of [0, 4, 4 | 32, 4 | 2].entries()) {
        sheet.node.addAnnot(
          ctx.register(
            ctx.obj({
              Type: 'Annot',
              Subtype: 'Square',
              F: flags,
              Rect: [20 + i * 40, 80, 40 + i * 40, 120],
              AP: {
                N: ctx.register(
                  ctx.flateStream('1 0 0 rg 0 0 20 40 re f', {
                    Type: 'XObject',
                    Subtype: 'Form',
                    BBox: [0, 0, 20, 40],
                  }),
                ),
              },
            }),
          ),
        );
      }
    } else {
      const groups = [
        [true, false],
        [true, true],
        [false, true],
        [false, false],
      ].map(([view, print], i) =>
        ctx.register(
          ctx.obj({
            Type: 'OCG',
            Name: PDFString.of(`Layer ${i}`),
            Usage: {
              View: { ViewState: view ? 'ON' : 'OFF' },
              Print: { PrintState: print ? 'ON' : 'OFF' },
            },
          }),
        ),
      );
      doc.catalog.set(
        PDFName.of('OCProperties'),
        ctx.obj({ OCGs: groups, D: { BaseState: 'ON' } }),
      );
      sheet.node.set(
        PDFName.of('Resources'),
        ctx.obj({ Properties: Object.fromEntries(groups.map((ref, i) => [`Layer${i}`, ref])) }),
      );
      sheet.node.set(
        PDFName.of('Contents'),
        ctx.register(
          ctx.flateStream(
            groups
              .map((_, i) => `/OC /Layer${i} BDC 1 0 0 rg ${20 + i * 40} 80 20 40 re f EMC`)
              .join('\n'),
          ),
        ),
      );
    }
    await openPdf(page, doc);
    const screenColors = () =>
      page
        .locator('.paper > canvas')
        .first()
        .evaluate((canvas) =>
          [30, 70, 110, 150].map(
            (x) =>
              canvas
                .getContext('2d')
                .getImageData((x * canvas.width) / 200, canvas.height / 2, 1, 1).data[1],
          ),
        );
    await expect.poll(screenColors).toEqual([0, 0, 255, 255]);
    await page.keyboard.press('ControlOrMeta+p');
    await page
      .getByRole('dialog', { name: 'Print', exact: true })
      .getByRole('button', { name: 'Print', exact: true })
      .click();
    await expect.poll(() => page.evaluate(() => window.printedColors)).not.toBeNull();
    const printed = await page.evaluate(() => window.printedColors);
    // JPEG rounding is allowed; red has a near-zero green channel and white a near-255 one.
    expect(printed.map((channel) => channel > 240)).toEqual([true, false, false, true]);
    await expect(page.locator('.print-sheets')).toHaveCount(0);
    await expect.poll(screenColors).toEqual([0, 0, 255, 255]);
  });
}

test('pages saved as pictures let go of their decoded pictures afterwards', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  // Each page shows a picture of its own, as a scan's pages do.
  const doc = await PDFDocument.create();
  for (let i = 0; i < 4; i++) {
    const sheet = doc.addPage([400, 500]);
    const picture = doc.context.flateStream(new Uint8Array(400 * 400 * 3).fill(40 + i * 40), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 400,
      Height: 400,
      ColorSpace: 'DeviceRGB',
      BitsPerComponent: 8,
    });
    const name = sheet.node.newXObject('Im', doc.context.register(picture));
    sheet.pushOperators(
      pushGraphicsState(),
      concatTransformationMatrix(300, 0, 0, 300, 50, 100),
      drawObject(name),
      popGraphicsState(),
    );
  }
  await openPdf(page, doc);
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  // Watch every page PDF.js draws, through the same PDF.js module the editor loaded.
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((name) => name.includes('/deps/pdfjs-dist.js'));
    const pdfjs = await import(url);
    const text =
      '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]>>endobj\ntrailer<</Root 1 0 R>>';
    const task = pdfjs.getDocument({ data: Uint8Array.from(text, (c) => c.charCodeAt(0)) });
    const proto = Object.getPrototypeOf(await (await task.promise).getPage(1));
    const render = proto.render;
    window.drawnPages = new Set();
    proto.render = function (...args) {
      window.drawnPages.add(this);
      return render.apply(this, args);
    };
  });
  const pending = page.waitForEvent('download');
  const bar = page.getByRole('menubar', { name: 'PDF menus' });
  if (await bar.isVisible()) await bar.getByRole('menuitem', { name: 'File', exact: true }).click();
  else await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Download pages as images…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Download pages as images', exact: true });
  await dialog.getByLabel('Page range', { exact: true }).fill('2-4');
  await dialog.getByRole('button', { name: 'Download', exact: true }).click();
  expect((await pending).suggestedFilename()).toBe('test pages.zip');
  const held = await page.evaluate(() =>
    [...window.drawnPages]
      .filter((pdfPage) => pdfPage.pageNumber > 1)
      .map((pdfPage) => [pdfPage.pageNumber, [...pdfPage.objs].length]),
  );
  expect(held.map(([number]) => number).sort()).toEqual([2, 3, 4]);
  expect(held.filter(([, count]) => count)).toEqual([]);
});
