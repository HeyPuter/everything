import { clickAway } from './editing-helpers.js';
import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import fontkit from '@pdf-lib/fontkit';

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
const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

test('canonical accents retain paragraph wrapping and remain editable after reopening', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]).drawText('Original paragraph for editing.\nSecond line here.', {
    x: 30,
    y: 300,
    size: 18,
    lineHeight: 24,
  });
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await expect(page.locator('.text-target')).toHaveCount(1);
  await page.locator('.text-target').click();
  const input = page.getByRole('textbox', { name: 'Edit text', exact: true });
  const text = 'Änne übt für nächste Woche.\nÜberall schöne Grüße.';
  await input.fill(text.normalize('NFD'));
  await page.getByLabel('Paragraph width in points', { exact: true }).fill('130');
  await page.getByLabel('Paragraph width in points', { exact: true }).press('Tab');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = await PDFDocument.load(await readFile(await (await pending).path()));
  await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
  await openPdf(page, saved);
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await expect(page.locator('.text-target')).toHaveCount(1);
  await page.locator('.text-target').click();
  await expect.poll(() => input.evaluate((el) => el.value)).toBe(text);
  await expect(page.getByLabel('Paragraph width in points', { exact: true })).toHaveValue('130');
  await clickAway(page);
  await settled(page);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

for (const face of ['Bold', 'Italic', 'BoldItalic']) {
  test(`custom-named ${face} text keeps its descriptor style in controls and export`, async ({
    page,
  }) => {
    await mockPuter(page);
    await page.goto('/#library');
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(
      await readFile(new URL(`../../public/fonts/NotoSans-${face}.ttf`, import.meta.url)),
      {
        subset: true,
        customName: 'ReportFace',
      },
    );
    doc.addPage([400, 400]).drawText('Original', { font, x: 40, y: 300, size: 24 });
    await doc.flush();
    if (face.includes('Bold'))
      doc.context
        .lookup(font.ref)
        .lookup(PDFName.of('DescendantFonts'))
        .lookup(0)
        .lookup(PDFName.of('FontDescriptor'))
        .set(PDFName.of('FontWeight'), doc.context.obj(700));
    await openPdf(page, doc);
    await page.getByRole('button', { name: 'Text', exact: true }).click();
    await page.getByRole('button', { name: 'Edit text: Original', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Bold', exact: true })).toHaveAttribute(
      'aria-pressed',
      String(face.includes('Bold')),
    );
    await expect(page.getByRole('button', { name: 'Italic', exact: true })).toHaveAttribute(
      'aria-pressed',
      String(face.includes('Italic')),
    );
    await page.getByRole('textbox', { name: 'Edit text', exact: true }).fill('Quick zebra');
    await clickAway(page);
    await settled(page);
    expect(await exportedFonts(page)).toContain(`NotoSans-${face}`);
  });
}

test('new regular text loads and measures the same font that is exported', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([600, 400]);
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.getByRole('button', { name: 'Place at page center', exact: true }).click();
  const draft = page.getByRole('textbox', { name: 'Text to add', exact: true });
  await draft.fill('iiii WWWW');
  await expect
    .poll(() =>
      draft.evaluate((input) => {
        const family = getComputedStyle(input).fontFamily;
        return [...document.fonts].some(
          (face) =>
            family.includes(face.family.replaceAll('"', '').replaceAll("'", '')) &&
            face.status === 'loaded' &&
            face.weight === '400' &&
            face.style === 'normal',
        );
      }),
    )
    .toBe(true);
  const measurements = await draft.evaluate(async (input) => {
    const reference = await new FontFace(
      'FontReference',
      'url(./fonts/NotoSans-Regular.ttf)',
    ).load();
    document.fonts.add(reference);
    const style = getComputedStyle(input);
    const canvas = document.createElement('canvas').getContext('2d');
    canvas.fontKerning = style.fontKerning;
    canvas.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const actual = canvas.measureText(input.value).width;
    canvas.font = `${style.fontSize} FontReference`;
    const expected = canvas.measureText(input.value).width;
    document.fonts.delete(reference);
    return { actual, expected };
  });
  expect(measurements.actual).toBeCloseTo(measurements.expected, 3);
  await page.getByRole('button', { name: 'Bold', exact: true }).click();
  await page.getByRole('button', { name: 'Bold', exact: true }).click();
  await expect(draft).toHaveCSS('font-family', /Noto Sans Styled/);
  await clickAway(page);
  await settled(page);
  expect(await exportedFonts(page)).toEqual(['NotoSans-Regular']);
});

for (const kind of ['new', 'existing', 'grouped'])
  test(`Escape while composing text leaves the ${kind} text draft open`, async ({ page }) => {
    await mockPuter(page);
    await page.goto('/#library');
    const doc = await PDFDocument.create();
    const pdfPage = doc.addPage([400, 400]);
    if (kind === 'existing') pdfPage.drawText('Original text', { x: 40, y: 300, size: 18 });
    if (kind === 'grouped') {
      const font = await doc.embedFont(StandardFonts.Helvetica);
      pdfPage.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F: font.ref } }));
      pdfPage.node.set(
        PDFName.of('Contents'),
        doc.context.register(
          doc.context.flateStream('BT /F 18 Tf 40 300 Td (Original ) Tj (text) Tj ET'),
        ),
      );
    }
    await openPdf(page, doc);
    await page.getByRole('button', { name: 'Text', exact: true }).click();
    await page
      .getByRole('button', {
        name: kind === 'new' ? 'Place at page center' : 'Edit text: Original text',
        exact: true,
      })
      .click();
    const input = page.getByRole('textbox', {
      name: kind === 'new' ? 'Text to add' : 'Edit text',
      exact: true,
    });
    await input.fill('Keep this draft ');
    await input.press('End');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: 'α', selectionStart: 1, selectionEnd: 1 });
    await input.press('Control+Enter');
    await expect(input).toBeVisible();
    await input.evaluate((el) =>
      el.addEventListener(
        'keydown',
        (e) => {
          window.composingKey = { key: e.key, composing: e.isComposing };
        },
        { capture: true, once: true },
      ),
    );
    await input.press('Escape');
    expect(await page.evaluate(() => window.composingKey)).toEqual({
      key: 'Escape',
      composing: true,
    });
    await expect(input).toBeVisible();
    await expect.poll(() => input.evaluate((el) => el.value)).toContain('Keep this draft');
    // End the IME session explicitly, then the ordinary cancel shortcut still works.
    await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
    await input.press('Escape');
    await expect(input).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  });

for (const style of ['Bold', 'Italic', 'Underline', 'Strikethrough'])
  test(`${style}-only drafts are unsaved, reversible, and protected when leaving`, async ({
    page,
  }) => {
    await mockPuter(page);
    await page.goto('/#library');
    const doc = await PDFDocument.create();
    doc.addPage([400, 400]).drawText('Plain line', { x: 40, y: 300, size: 18 });
    await openPdf(page, doc);
    await page.getByRole('button', { name: 'Text', exact: true }).click();
    const target = page.getByRole('button', { name: 'Edit text: Plain line', exact: true });
    const toggle = page.getByRole('button', { name: style, exact: true });
    const undo = page.getByRole('button', { name: 'Undo', exact: true });
    await target.click();
    await toggle.click();
    await expect(page.locator('.save-status')).toHaveText('Unsaved changes');
    await expect(undo).toBeEnabled();
    await expect(page).toHaveTitle(/^\* /);
    await toggle.click();
    await expect(page.locator('.save-status')).toHaveText('Local file');
    await expect(undo).toBeDisabled();
    await toggle.click();
    await undo.click();
    await expect(page.getByRole('textbox', { name: 'Edit text', exact: true })).toHaveCount(0);
    await expect(undo).toBeDisabled();
    await target.click();
    await toggle.click();
    await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await clickAway(page);
    await settled(page);
    expect(await exportedFonts(page)).toContain(
      ['Bold', 'Italic'].includes(style) ? `NotoSans-${style}` : 'Helvetica',
    );
    await target.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });

/** The font names used on the first page of the exported PDF, without subset prefixes. */
async function exportedFonts(page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const doc = await PDFDocument.load(await readFile(await (await pending).path()));
  const fonts = doc.getPage(0).node.Resources().lookup(PDFName.of('Font'));
  return (
    fonts
      .entries()
      .map(([, ref]) => doc.context.lookup(ref).lookup(PDFName.of('BaseFont')).decodeText())
      // Subset prefixes and pdf-lib's numeric suffixes are noise here.
      .map((name) => name.replace(/^[A-Z]{6}\+/, '').replace(/-\d+$/, ''))
      .sort()
  );
}

test('new text can be bold and italic, and editing it keeps and changes the style', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  const bold = page.getByRole('button', { name: 'Bold', exact: true });
  const italic = page.getByRole('button', { name: 'Italic', exact: true });
  await expect(bold).toHaveAttribute('aria-pressed', 'false');
  await bold.click();
  await italic.click();
  await expect(bold).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Place at page center', exact: true }).click();
  const draft = page.getByRole('textbox', { name: 'Text to add', exact: true });
  await draft.fill('Styled words');
  await expect(draft).toHaveCSS('font-weight', '700');
  await expect(draft).toHaveCSS('font-style', 'italic');
  await clickAway(page);
  await settled(page);
  expect(await exportedFonts(page)).toEqual(['NotoSans-BoldItalic']);
  // Editing the text shows its style pressed; turning italic off swaps the face.
  await page.getByRole('button', { name: 'Edit text: Styled words', exact: true }).click();
  await expect(bold).toHaveAttribute('aria-pressed', 'true');
  await expect(italic).toHaveAttribute('aria-pressed', 'true');
  await italic.click();
  await expect(page.getByRole('textbox', { name: 'Edit text', exact: true })).toHaveCSS(
    'font-style',
    'normal',
  );
  await clickAway(page);
  await settled(page);
  // The superseded face may linger in the page's resources; the bold one is in use now.
  expect(await exportedFonts(page)).toContain('NotoSans-Bold');
  // The defaults for new text stay as chosen while the edited line kept its own.
  await expect(bold).toHaveAttribute('aria-pressed', 'true');
  await expect(italic).toHaveAttribute('aria-pressed', 'true');
});

test('an unchanged edit of plain text stays a no-op and its toggles start unpressed', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([400, 400]).drawText('Plain line', { x: 40, y: 300, size: 18, font });
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.getByRole('button', { name: 'Edit text: Plain line', exact: true }).click();
  const bold = page.getByRole('button', { name: 'Bold', exact: true });
  await expect(bold).toHaveAttribute('aria-pressed', 'false');
  await clickAway(page);
  await settled(page);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  // Making it bold re-sets the line in Noto Sans Bold.
  await page.getByRole('button', { name: 'Edit text: Plain line', exact: true }).click();
  await bold.click();
  await clickAway(page);
  await settled(page);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  expect(await exportedFonts(page)).toContain('NotoSans-Bold');
});

test('the Text size list offers the usual sizes and only the selected text’s own', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const sheet = doc.addPage([400, 400]);
  for (const [i, size] of [9.5, 13.3, 18.7].entries())
    sheet.drawText(`Sized ${size}`, { x: 40, y: 320 - i * 60, size, font });
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  const sizes = page.getByLabel('Text size', { exact: true });
  const offered = () => sizes.evaluate((list) => [...list.options].map((o) => o.value).join(' '));
  for (const size of ['9.5', '13.3', '18.7']) {
    await page.getByRole('button', { name: `Edit text: Sized ${size}`, exact: true }).click();
    await expect(sizes).toHaveValue(size);
    await page.keyboard.press('Escape');
    await settled(page);
  }
  // Selecting text in three odd sizes left one of them in the list, not all three.
  expect(await offered()).toBe('10 12 16 18.7 20 24 32 48');
  await page.getByRole('button', { name: 'Edit text: Sized 9.5', exact: true }).click();
  await expect(sizes).toHaveValue('9.5');
  expect(await offered()).toBe('9.5 10 12 16 20 24 32 48');
});
