import { test, expect } from '@playwright/test';

// The second pane of View › Split copied every page after each paint, and first painted all the pages
// the editor leaves for later: in a long document each keystroke took about twice as long with the
// split open. It now copies the pages it shows, and the others when it scrolls to them.
test('a split view copies only the pages its pane shows, and the rest as it scrolls', async ({ page }) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill(Array.from({ length: 400 }, (_, i) => `Paragraph ${i} ` + 'lorem ipsum dolor sit amet consectetur '.repeat(8)).join('\n'));
  const pages = await page.locator('.canvas-host canvas.canvas-page').count();
  expect(pages).toBeGreaterThan(40);
  await page.locator('#ribbon-tab-view').click();
  await page.locator('.ribbon-card').getByRole('button', { name: 'Split', exact: true }).click();
  const pane = page.locator('.view-split-pane');
  await expect(pane.locator('canvas')).toHaveCount(pages);
  // Count the page copies one keystroke makes.
  await page.evaluate(() => {
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    window.mirrorCopies = 0;
    CanvasRenderingContext2D.prototype.drawImage = function (...args) {
      if (this.canvas.closest?.('.view-split-pane')) window.mirrorCopies++;
      return draw.apply(this, args);
    };
  });
  await input.focus(); await input.press('ControlOrMeta+Home');
  await page.waitForTimeout(500);
  await page.evaluate(() => { window.mirrorCopies = 0; });
  await page.keyboard.insertText('x');
  await expect(input).toHaveValue(/^xParagraph 0/i);
  await page.waitForTimeout(500);
  const copies = await page.evaluate(() => window.mirrorCopies);
  expect(copies).toBeGreaterThan(0);
  expect(copies).toBeLessThan(10);
  // The pane shows the typed text, and a page it scrolls to is drawn when it comes into view.
  const ink = index => pane.locator('canvas').nth(index).evaluate(c => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] && d[i] < 128) n++; return n; });
  expect(await ink(0)).toBeGreaterThan(100);
  const last = pages - 1;
  await pane.evaluate((el, last) => { el.scrollTop = el.querySelectorAll('canvas')[last].offsetTop; }, last);
  await expect.poll(() => ink(last)).toBeGreaterThan(100);
});
