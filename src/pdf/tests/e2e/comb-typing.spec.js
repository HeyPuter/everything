import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, PDFNumber, TextAlignment } from 'pdf-lib';
import { loadImage, createCanvas } from '@napi-rs/canvas';

/** The first and last columns of dark ink in a screenshot of a control. */
async function inkColumns(locator) {
  const image = await loadImage(await locator.screenshot());
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const { data } = context.getImageData(0, 0, image.width, image.height);
  const columns = [];
  for (let x = 0; x < image.width; x++)
    for (let y = 3; y < image.height - 3; y++) {
      const at = (y * image.width + x) * 4;
      if (data[at] + data[at + 1] + data[at + 2] < 300) {
        columns.push(x);
        break;
      }
    }
  return { width: image.width, first: columns[0], last: columns.at(-1) };
}

// The boxes the saved drawing fills for each alignment (comb-alignment.test.js).
for (const [alignment, text, firstBox] of [
  [TextAlignment.Left, '42', 0],
  [TextAlignment.Center, '42', 1],
  [TextAlignment.Right, '42', 3],
  [TextAlignment.Left, '42719', 0],
  [TextAlignment.Right, '42719', 0],
])
  test(`typing "${text}" in a comb field puts each character in its box (Q=${alignment})`, async ({
    page,
  }) => {
    await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
    await page.goto('/#library');
    const doc = await PDFDocument.create();
    const field = doc.getForm().createTextField('Amount');
    field.setMaxLength(5);
    field.enableCombing();
    field.addToPage(doc.addPage([600, 400]), {
      x: 100,
      y: 300,
      width: 200,
      height: 30,
      borderWidth: 0,
    });
    field.acroField.dict.set(PDFName.of('Q'), PDFNumber.of(alignment));
    const pending = page.waitForEvent('filechooser');
    await page.keyboard.press('ControlOrMeta+o');
    await (
      await pending
    ).setFiles({
      name: 'comb.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(await doc.save()),
    });
    await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
    const input = page.getByRole('textbox', { name: 'Amount (on page)', exact: true });
    await input.fill(text);
    const { width, first, last } = await inkColumns(input.locator('..'));
    const cell = width / 5;
    // Each glyph sits in the middle of its box, clear of the box edges.
    const start = firstBox * cell,
      end = (firstBox + text.length) * cell;
    expect(first).toBeGreaterThan(start + 0.15 * cell);
    expect(first).toBeLessThan(start + 0.5 * cell);
    expect(last).toBeGreaterThan(end - 0.5 * cell);
    expect(last).toBeLessThan(end - 0.15 * cell);
  });
