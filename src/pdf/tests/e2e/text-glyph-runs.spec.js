import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';

// Some generators place every glyph on its own, so a paragraph is thousands of runs. Styling the
// draft read its whole text once for each run, which took seconds to open it and per keystroke.
test('a paragraph drawn glyph by glyph opens for editing and takes keys without rereading it per glyph', async ({
  page,
}) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const sheet = doc.addPage([612, 792]);
  sheet.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F: font.ref } }));
  const words = 'Each glyph of this paragraph is placed on its own by the program that wrote it. ';
  let source = 'BT /F 8 Tf\n';
  for (let row = 0; row < 16; row++) {
    let x = 30;
    for (const char of words.repeat(2).slice(0, 125)) {
      source += `1 0 0 1 ${x.toFixed(2)} ${700 - row * 9.5} Tm (${char}) Tj\n`;
      x += font.widthOfTextAtSize(char, 8);
    }
  }
  sheet.node.set(
    PDFName.of('Contents'),
    doc.context.register(doc.context.flateStream(`${source}ET`)),
  );
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'glyphs.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  const target = page.getByRole('button', { name: /^Edit text: Each glyph/ }).first();
  await expect(target).toBeVisible();
  // Count how often the draft's spans are read: a few times over for each keystroke, not once
  // for every span for each span (millions of reads here).
  await page.evaluate(() => {
    const { get } = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'dataset');
    window.datasetReads = 0;
    Object.defineProperty(HTMLElement.prototype, 'dataset', {
      configurable: true,
      get() {
        window.datasetReads++;
        return get.call(this);
      },
    });
  });
  await target.click({ position: { x: 3, y: 3 } });
  const input = page.getByRole('textbox', { name: 'Edit text', exact: true });
  await expect(input).toBeFocused();
  const glyphs = await input.evaluate((el) => el.querySelectorAll('[data-part]').length);
  expect(glyphs).toBeGreaterThan(1500);
  await page.keyboard.type('ok');
  await expect.poll(() => input.evaluate((el) => el.value.includes('ok'))).toBe(true);
  expect(await page.evaluate(() => window.datasetReads)).toBeLessThan(glyphs * 500);
});
