import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

// A page that takes a moment to draw: many short strokes.
async function busyPdf() {
  const doc = await PDFDocument.create();
  for (let p = 0; p < 2; p++) {
    const page = doc.addPage([612, 792]);
    let ops = '';
    for (let i = 0; i < 40000; i++) {
      const x = (i * 37) % 600,
        y = (i * 91) % 780;
      ops += `${x} ${y} m ${x + 9} ${y + 13} l S\n`;
    }
    page.node.addContentStream(doc.context.register(doc.context.flateStream(ops)));
  }
  return doc;
}

// The pages are stretched while two fingers pinch, and drawn afresh at the new zoom once they
// lift. The stretch used to be dropped the moment they lifted, so the page sprang back to its
// old size for as long as it took to draw, and only then jumped to the new one.
test('a pinch keeps its stretched pages until the new zoom is drawn', async ({ page }) => {
  test.skip(test.info().project.name !== 'mobile', 'Pinching takes a touch screen.');
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  const doc = await busyPdf();
  await (
    await chooser
  ).setFiles({
    name: 'busy.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  const view = await page.locator('.workspace').boundingBox();
  const point = { x: view.x + view.width / 2, y: view.y + view.height / 2 };
  const before = await page.locator('.paper').evaluate((node) => {
    const box = node.getBoundingClientRect();
    return box.width;
  });
  const under = () =>
    page.evaluate(({ x, y }) => {
      const box = document.querySelector('.paper').getBoundingClientRect();
      return [(x - box.left) / box.width, (y - box.top) / box.height];
    }, point);
  const spot = await under();
  // Every frame's page width, from the pinch until the zoom has settled.
  await page.evaluate(() => {
    window.widths = [];
    const frame = () => {
      window.widths.push(document.querySelector('.paper').getBoundingClientRect().width);
      if (window.widths.length < 240) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.synthesizePinchGesture', {
    ...point,
    scaleFactor: 1.6,
    gestureSourceType: 'touch',
  });
  await expect(page.getByLabel('Zoom', { exact: true })).not.toHaveValue('fit');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await expect.poll(() => page.evaluate(() => window.widths.length)).toBe(240);
  const widths = await page.evaluate(() => window.widths);
  const stretched = widths.findIndex((width) => width > before + 20);
  expect(stretched).toBeGreaterThanOrEqual(0);
  // Once stretched, the page never shows at its old size again.
  expect(Math.min(...widths.slice(stretched))).toBeGreaterThan(before + 20);
  // The spot under the fingers stays under them.
  const after = await under();
  expect(Math.abs(after[0] - spot[0])).toBeLessThan(0.02);
  expect(Math.abs(after[1] - spot[1])).toBeLessThan(0.02);
});
