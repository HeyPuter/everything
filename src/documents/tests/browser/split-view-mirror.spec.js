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

// Pages far from the first pane's view give up their pixels (CanvasEditor.releasePages). The second pane still
// shows them at their size and with current content, after a zoom change or an edit made while they were released.
test('the second pane shows pages released by the first at their size, after zoom changes and edits', async ({ page }) => {
  test.setTimeout(120000);
  await page.addInitScript(() => localStorage.setItem('documents:spellcheck', 'off'));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.evaluate(() => {
    const e = window.__docs.current.view.engine;
    e.model.select(0);
    e.execute(() => e.model.replace(Array.from({ length: 400 }, (_, i) => `Paragraph ${i} ` + 'lorem ipsum dolor sit amet consectetur '.repeat(8)).join('\n')));
    e.model.select(0); e.paint();
  });
  const count = await page.evaluate(() => window.__docs.current.view.engine.canvases.length);
  expect(count).toBeGreaterThan(40);
  await page.locator('#ribbon-tab-view').click();
  await page.locator('.ribbon-card').getByRole('button', { name: 'Split', exact: true }).click();
  const pane = page.locator('.view-split-pane');
  await expect(pane.locator('canvas')).toHaveCount(count);
  // The first pane shows the start of the document.
  await page.evaluate(() => { window.__docs.current.view.engine.host.scrollTop = 0; });
  const last = count - 1;
  const released = index => page.evaluate(index => window.__docs.current.view.engine.releasedPages.has(index), index);
  // The last page is far from the first pane's view: once the browser is idle it gives up its pixels.
  await expect.poll(() => released(last), { timeout: 15000 }).toBe(true);
  // Whether the second pane's copy of a page shows it as it is: the page's own size and pixels. The copy is read
  // first; painting the page for comparison makes the pane copy it again afterwards.
  const matches = index => page.evaluate(index => {
    const e = window.__docs.current.view.engine, copy = document.querySelectorAll('.view-split-pane canvas')[index];
    const [width, height] = [copy.width, copy.height], a = width && height ? copy.getContext('2d').getImageData(0, 0, width, height).data : null;
    const source = e.canvases[index]; e.paint({ pages: [index] });
    if (width !== source.width || height !== source.height) return `size ${width}x${height} vs ${source.width}x${source.height}`;
    const b = source.getContext('2d').getImageData(0, 0, source.width, source.height).data;
    for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) > 2 || Math.abs(a[i + 3] - b[i + 3]) > 2) return 'pixels differ';
    return 'same';
  }, index);
  // Zoom changes while the page is released, then the second pane scrolls to it.
  await page.evaluate(() => window.__docs.current.view.engine.setZoom(0.8));
  await expect.poll(() => released(last), { timeout: 15000 }).toBe(true);
  await pane.evaluate((el, last) => { el.scrollTop = el.querySelectorAll('canvas')[last].offsetTop; }, last);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  // The copy has the page's size at the new zoom, not the one it had before.
  expect(await page.evaluate(last => { const { width, height } = window.__docs.current.view.engine.backingSize(last), copy = document.querySelectorAll('.view-split-pane canvas')[last]; return [copy.width - width, copy.height - height]; }, last)).toEqual([0, 0]);
  expect(await matches(last)).toBe('same');
  // An edit moves the text of every later page while the second pane shows the last one: it follows.
  await page.locator('.canvas-host canvas.canvas-page').first().click({ position: { x: 150, y: 110 } });
  await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
  await page.waitForTimeout(2500);
  expect(await matches(last)).toBe('same');
});
