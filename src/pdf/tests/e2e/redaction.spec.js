import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import {
  PDFDocument,
  PDFName,
  StandardFonts,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
  rgb,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const PUTER_MOCK = `window.puter = { env: 'web', auth: { isSignedIn: () => true, getUser: async () => ({username:'test-user'}), signIn: async () => {}, signOut: async () => {} }, fs: { readdir: async () => [], write: async () => ({}) }, ui: { onLaunchedWithItems: () => {}, onItemsOpened: () => {} } };`;
test.skip(({ isMobile }) => isMobile, 'desktop workspace');

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

test('Apply redactions counts what it removed in words that agree with the numbers', async ({
  page,
}) => {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
  );
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const sheet = doc.addPage([300, 300]);
  sheet.drawText('X', { x: 40, y: 200, size: 16, font });
  sheet.drawRectangle({ x: 100, y: 100, width: 50, height: 50, color: rgb(0.2, 0.4, 0.8) });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'one.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'Redact a PDF', exact: true }).click();
  await pane.getByRole('button', { name: 'Redact pages…' }).click();
  await page
    .getByRole('dialog', { name: 'Redact pages' })
    .getByRole('button', { name: 'Mark pages' })
    .click();
  await settled(page);
  await pane.getByRole('button', { name: 'Apply redactions…' }).click();
  const confirm = page.getByRole('dialog', { name: 'Apply redactions' });
  await confirm.getByLabel(/Also remove hidden information/).uncheck();
  await confirm.getByRole('button', { name: 'Apply', exact: true }).click();
  await settled(page);
  await expect(page.locator('#toast')).toContainText(
    'Redactions applied: removed 1 character, 1 drawing.',
  );
});

test('Find text and redact lists its matches with the dialogs’ own check boxes', async ({
  page,
}) => {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
  );
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([300, 300]).drawText('Call 555-123-4567', { x: 40, y: 200, size: 14, font });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'call.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'Redact a PDF', exact: true }).click();
  await pane.getByRole('button', { name: 'Find text and redact…' }).click();
  const finder = page.getByRole('dialog', { name: 'Find text and redact' });
  const pattern = finder.getByLabel('Phone numbers');
  await pattern.check();
  await finder.getByRole('button', { name: 'Search' }).click();
  const match = finder.getByRole('checkbox', { name: 'Page 1: 555-123-4567' });
  await expect(match).toBeChecked();
  // The match boxes were the browser's small blue default beside the red pattern boxes.
  const look = (box) =>
    box.evaluate((node) => {
      const style = getComputedStyle(node);
      return [style.accentColor, node.getBoundingClientRect().width];
    });
  expect(await look(match)).toEqual(await look(pattern));
  // Dialog labels are blocks of small bold text, which put the box above its words and
  // against them; it sits beside them, centred, as the pattern boxes do.
  const row = await match.evaluate((node) => {
    const label = node.closest('label');
    const box = node.getBoundingClientRect(),
      text = label.querySelector('span').getBoundingClientRect();
    return {
      gap: text.left - box.right,
      offset: Math.abs(box.top + box.height / 2 - (text.top + text.height / 2)),
      weight: getComputedStyle(label).fontWeight,
    };
  });
  expect(row.gap).toBeGreaterThanOrEqual(8);
  expect(row.offset).toBeLessThanOrEqual(1.5);
  expect(row.weight).toBe('500');
});

test('the redaction tool’s hint names its own command, not Highlight', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
  );
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([300, 300]).drawText('Account 12345678', { x: 40, y: 200, size: 14, font });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'account.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'Redact a PDF', exact: true }).click();
  await pane.getByRole('button', { name: /Redact text and images/ }).click();
  const hint = page.locator('.tool-hint');
  // It read "Select text, then choose Highlight selection", a button the tool does not show.
  await expect(hint).toHaveText(
    'Select text, then choose Mark selection for redaction. Choose Area to drag over pictures or any part of the page.',
  );
  await page.getByRole('combobox', { name: 'Highlight mode' }).selectOption('area');
  await expect(hint).toHaveText('Drag over an area to mark it for redaction.');
});

test('marks waiting to be applied have names that tell them apart', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
  );
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const sheet = doc.addPage([300, 300]);
  sheet.drawText('Call 555-123-4567', { x: 40, y: 200, size: 14, font });
  sheet.drawText('Fax 555-987-6543', { x: 40, y: 150, size: 14, font });
  doc.addPage([300, 300]).drawText('Call 555-222-3333', { x: 40, y: 200, size: 14, font });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'calls.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'Redact a PDF', exact: true }).click();
  // Each search marks what it finds on a page as one mark.
  for (const query of ['555-123-4567', '555-987-6543', '555-222-3333']) {
    await pane.getByRole('button', { name: 'Find text and redact…' }).click();
    const finder = page.getByRole('dialog', { name: 'Find text and redact' });
    await finder.getByLabel('Find text').fill(query);
    await finder.getByRole('button', { name: 'Search' }).click();
    await expect(finder.getByRole('status')).toHaveText(/^1 match found/);
    await finder.getByRole('button', { name: 'Mark selected' }).click();
    await expect(finder).toBeHidden();
    await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  }
  await expect(pane.getByText('3 marks to apply')).toBeVisible();
  // Both marks on page 1 were "Remove mark on page 1", with nothing to tell them apart.
  await expect(pane.getByRole('button', { name: /^Remove mark/ })).toHaveText([
    'Remove mark 1 on page 1',
    'Remove mark 2 on page 1',
    'Remove mark on page 2',
  ]);
});

test('marking a selected word leaves the letters of the lines around it', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
  );
  await page.goto('/#library');
  // Word sets single-spaced 12 pt text 13.8 pt apart, while fonts such as Arial and Noto Sans
  // reach further above and below their lines than that leaves room for.
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(
    await readFile(new URL('../../public/fonts/NotoSans-Regular.ttf', import.meta.url)),
    { subset: true },
  );
  const sheet = doc.addPage([400, 300]);
  ['Alpha SECRET Bravo', 'Charlie Delta Echo', 'Foxtrot Golf Hotel'].forEach((line, i) =>
    sheet.drawText(line, { x: 40, y: 200 - i * 13.8, size: 12, font }),
  );
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'lines.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'Redact a PDF', exact: true }).click();
  await pane.getByRole('button', { name: /Redact text and images/ }).click();
  const word = page.locator('.textLayer span', { hasText: 'SECRET' }).first();
  await expect(word).toBeVisible();
  await word.evaluate((span) => {
    const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
    const node = walker.nextNode();
    const at = node.textContent.indexOf('SECRET');
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + 'SECRET'.length);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await page.getByRole('button', { name: 'Mark selection for redaction' }).click();
  await settled(page);
  await expect(pane.getByText('1 mark to apply')).toBeVisible();
  await pane.getByRole('button', { name: 'Apply redactions…' }).click();
  const confirm = page.getByRole('dialog', { name: 'Apply redactions' });
  await confirm.getByLabel(/Also remove hidden information/).uncheck();
  await confirm.getByRole('button', { name: 'Apply', exact: true }).click();
  await settled(page);
  // The marked word's line box reached into the next line, whose middle letters went with it.
  await expect(page.locator('#toast')).toContainText('removed 6 characters');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const bytes = await readFile(await (await download).path());
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false });
  const pdf = await task.promise;
  const text = (await (await pdf.getPage(1)).getTextContent()).items
    .map((item) => item.str)
    .join('|');
  await task.destroy();
  expect(text).not.toContain('SECRET');
  for (const line of ['Charlie Delta Echo', 'Foxtrot Golf Hotel']) expect(text).toContain(line);
  expect(text).toMatch(/Alpha.*Bravo/);
});

test('text found by both the typed words and a pattern is listed and marked once', async ({
  page,
}) => {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
  );
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([300, 300]).drawText('Call 555-123-4567', { x: 40, y: 200, size: 14, font });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'call.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'Redact a PDF', exact: true }).click();
  await pane.getByRole('button', { name: 'Find text and redact…' }).click();
  const finder = page.getByRole('dialog', { name: 'Find text and redact' });
  await finder.getByLabel('Find text').fill('555-123-4567');
  await finder.getByLabel('Phone numbers').check();
  await finder.getByRole('button', { name: 'Search' }).click();
  // The number was listed twice, and marking it made two marks over the same words.
  await expect(finder.getByRole('status')).toHaveText(/^1 match found/);
  await expect(finder.getByRole('checkbox', { name: /^Page 1:/ })).toHaveCount(1);
  await finder.getByRole('button', { name: 'Mark selected' }).click();
  await expect(finder).toBeHidden();
  await settled(page);
  await expect(pane.getByText('1 mark to apply')).toBeVisible();
});

test('redaction properties refuse overlay text the applied marks cannot show', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
  );
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([300, 300]).drawText('Account 12345678', { x: 40, y: 200, size: 14, font });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'account.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'Redact a PDF', exact: true }).click();
  await pane.getByRole('button', { name: 'Redaction properties…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Redaction properties' });
  const overlay = dialog.getByLabel('Overlay text', { exact: true });
  // The marks' overlay font draws Latin text only: these were saved, then left out unseen.
  await overlay.fill('機密');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog.getByRole('alert')).toHaveText(
    'Overlay text cannot show 機 密. Use Latin letters, digits, and punctuation.',
  );
  await expect(dialog).toBeVisible();
  await expect(overlay).toBeFocused();
  await overlay.fill('Redacted');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#toast')).toHaveText('New redaction marks use these settings.');
});

test('a picture under part of a mark is reported as erased there, not removed', async ({
  page,
}) => {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
  );
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const sheet = doc.addPage([300, 300]);
  sheet.drawText('X', { x: 40, y: 200, size: 16, font });
  const pixels = new Uint8Array(8 * 8 * 3).fill(200);
  const picture = doc.context.register(
    doc.context.flateStream(pixels, {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 8,
      Height: 8,
      ColorSpace: 'DeviceRGB',
      BitsPerComponent: 8,
    }),
  );
  sheet.node.setXObject(PDFName.of('Pic'), picture);
  sheet.pushOperators(...[pushGraphicsState(), concatTransformationMatrix(80, 0, 0, 80, 100, 50)]);
  sheet.pushOperators(drawObject('Pic'), popGraphicsState());
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'picture.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'Redact a PDF', exact: true }).click();
  await pane.getByRole('button', { name: 'Redact pages…' }).click();
  await page
    .getByRole('dialog', { name: 'Redact pages' })
    .getByRole('button', { name: 'Mark pages' })
    .click();
  await settled(page);
  await pane.getByRole('button', { name: 'Apply redactions…' }).click();
  const confirm = page.getByRole('dialog', { name: 'Apply redactions' });
  await confirm.getByLabel(/Also remove hidden information/).uncheck();
  await confirm.getByRole('button', { name: 'Apply', exact: true }).click();
  await settled(page);
  // It said "removed 1 character, 1 image" for a picture whose pixels were painted over.
  await expect(page.locator('#toast')).toContainText(
    'Redactions applied: removed 1 character; erased the marked part of 1 image.',
  );
});

test('Apply redactions says its hidden-information option also takes links', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
  );
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const sheet = doc.addPage([300, 300]);
  sheet.drawText('Account 12345678', { x: 40, y: 200, size: 14, font });
  sheet.drawText('Our site', { x: 40, y: 100, size: 14, font });
  const link = doc.context.register(
    doc.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [40, 95, 100, 115],
      Border: [0, 0, 0],
      A: { S: 'URI', URI: doc.context.obj('https://example.org/') },
    }),
  );
  sheet.node.set(PDFName.of('Annots'), doc.context.obj([link]));
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'site.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'Redact a PDF', exact: true }).click();
  await pane.getByRole('button', { name: 'Find text and redact…' }).click();
  const finder = page.getByRole('dialog', { name: 'Find text and redact' });
  await finder.getByLabel('Find text').fill('12345678');
  await finder.getByRole('button', { name: 'Search' }).click();
  await finder.getByRole('button', { name: 'Mark selected' }).click();
  await settled(page);
  await pane.getByRole('button', { name: 'Apply redactions…' }).click();
  const confirm = page.getByRole('dialog', { name: 'Apply redactions' });
  // The option named metadata, scripts, attachments, and hidden text, but it also removes
  // every web link, far from any mark, and the text recognized on scans.
  const option = confirm.getByRole('checkbox', { name: /Also remove hidden information/ });
  await expect(option).toBeChecked();
  await expect(option).toHaveAccessibleName(/links to websites and files/);
  await expect(option).toHaveAccessibleName(/recognized OCR text/);
  await confirm.getByRole('button', { name: 'Apply', exact: true }).click();
  await settled(page);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = await PDFDocument.load(await readFile(await (await download).path()));
  expect(saved.getPage(0).node.lookup(PDFName.of('Annots'))?.size() ?? 0).toBe(0);
});

test('Redact pages covers a page whose media box lists its corners the other way round', async ({
  page,
}) => {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
  );
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const sheet = doc.addPage([612, 792]);
  sheet.drawText('Shown INSIDE', { x: 100, y: 300, size: 14, font });
  // Hidden by the crop box but still in the page's content.
  sheet.drawText('Cropped OUTSIDE', { x: 10, y: 20, size: 14, font });
  sheet.drawText('Cropped ABOVE', { x: 520, y: 760, size: 14, font });
  sheet.node.set(PDFName.of('MediaBox'), doc.context.obj([612, 792, 0, 0]));
  sheet.node.set(PDFName.of('CropBox'), doc.context.obj([50, 50, 500, 700]));
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'reversed.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'Redact a PDF', exact: true }).click();
  await pane.getByRole('button', { name: 'Redact pages…' }).click();
  await page
    .getByRole('dialog', { name: 'Redact pages' })
    .getByRole('button', { name: 'Mark pages' })
    .click();
  await settled(page);
  await pane.getByRole('button', { name: 'Apply redactions…' }).click();
  const confirm = page.getByRole('dialog', { name: 'Apply redactions' });
  await confirm.getByLabel(/Also remove hidden information/).uncheck();
  await confirm.getByRole('button', { name: 'Apply', exact: true }).click();
  await settled(page);
  // The mark took only the crop box: [612 792 0 0] read as starting at 612 and running back.
  await expect(page.locator('#toast')).toContainText('removed 40 characters');
});

// Other tools may write redaction marks with only /Rect, /QuadPoints, and colours. PDF.js
// draws nothing for those, so the marks the tools pane listed were nowhere to be seen.
test('redaction marks without an appearance are outlined on the page', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
  );
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([300, 300]);
  const bare = doc.context.register(
    doc.context.obj({
      Type: 'Annot',
      Subtype: 'Redact',
      Rect: [40, 150, 140, 220],
      // Two areas: a line of words and the start of the next.
      QuadPoints: [40, 220, 140, 220, 40, 200, 140, 200, 40, 170, 100, 170, 40, 150, 100, 150],
      C: [0, 0, 1],
      IC: [0, 0, 0],
    }),
  );
  // A mark with an appearance of its own (here, an empty one) is drawn as that appearance says.
  const drawn = doc.context.register(
    doc.context.obj({
      Type: 'Annot',
      Subtype: 'Redact',
      Rect: [180, 40, 260, 80],
      C: [1, 0, 0],
      AP: {
        N: doc.context.register(
          doc.context.stream('', { Type: 'XObject', Subtype: 'Form', BBox: [180, 40, 260, 80] }),
        ),
      },
    }),
  );
  sheet.node.set(PDFName.of('Annots'), doc.context.obj([bare, drawn]));
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'marked.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);
  const pixel = (x, y) =>
    page
      .locator('.paper > canvas')
      .first()
      .evaluate(
        (canvas, [x, y]) => {
          const scale = canvas.width / 300;
          return Array.from(
            canvas
              .getContext('2d')
              .getImageData(Math.floor(x * scale), Math.floor((300 - y) * scale), 1, 1).data,
          ).slice(0, 3);
        },
        [x, y],
      );
  const blue = ([r, g, b]) => b > 180 && r < 120 && g < 120;
  // Each area's edges are outlined in the mark's colour, as the app's own marks are.
  await expect.poll(async () => blue(await pixel(40.5, 210))).toBe(true);
  expect(blue(await pixel(139.5, 210))).toBe(true);
  expect(blue(await pixel(70, 150.5))).toBe(true);
  // Only outlined, so the words under the mark can still be reviewed; and only the areas, not
  // the box around both.
  expect(await pixel(90, 210)).toEqual([255, 255, 255]);
  expect(await pixel(130, 160)).toEqual([255, 255, 255]);
  expect(await pixel(180.5, 60)).toEqual([255, 255, 255]);
});

test('Find text and redact lists each match once when Enter is pressed again while it searches', async ({
  page,
}) => {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
  );
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 12; i++)
    doc.addPage([300, 300]).drawText(`Secret code ${i}`, { x: 40, y: 200, size: 14, font });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'codes.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 12');
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'Redact a PDF', exact: true }).click();
  await pane.getByRole('button', { name: 'Find text and redact…' }).click();
  const finder = page.getByRole('dialog', { name: 'Find text and redact' });
  const query = finder.getByLabel('Find text');
  await query.fill('Secret');
  // A long document takes a while to search; Enter pressed again meanwhile.
  await query.evaluate((input) => {
    input.form.requestSubmit();
    input.form.requestSubmit();
  });
  await expect(finder.getByRole('status')).toContainText('12 matches found');
  await expect(finder.getByRole('checkbox', { name: /^Page \d+: Secret$/ })).toHaveCount(12);
  await finder.getByRole('button', { name: 'Mark selected' }).click();
  await expect(page.locator('#toast')).toContainText('12 matches marked for redaction');
});
