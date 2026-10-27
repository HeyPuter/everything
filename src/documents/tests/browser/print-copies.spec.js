import { test, expect } from '@playwright/test';

// What File > Print sends to the browser's print dialog, taken when the dialog would open.
async function printed(page, { range, copies }) {
  await page.evaluate(() => { window.sent = null; });
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.getByRole('tab', { name: 'Print' }).click();
  await expect(page.locator('.bs-page canvas').first()).toBeVisible();
  await page.evaluate(() => { window.printPainted = 0; });
  await page.getByRole('combobox', { name: 'Pages' }).selectOption(range);
  await page.getByRole('spinbutton', { name: 'Copies' }).fill(String(copies));
  await page.locator('.bs-print-button').click();
  await expect.poll(() => page.evaluate(() => window.sent)).toBeTruthy();
  return page.evaluate(() => window.sent);
}

test('printing paints only the pages chosen, and copies share one picture of each page', async ({ page }) => {
  test.setTimeout(120000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    // Each sheet's pixels and size, as the print stage holds them.
    window.print = () => {
      const sheets = [...document.querySelectorAll('.print-stage-pages > *')].map(node => {
        const canvas = document.createElement('canvas');
        canvas.width = node.naturalWidth ?? node.width; canvas.height = node.naturalHeight ?? node.height;
        canvas.getContext('2d').drawImage(node, 0, 0);
        return { tag: node.tagName, source: node.src || null, width: node.style.width, height: node.style.height, page: node.style.page, pixels: canvas.toDataURL() };
      });
      window.sent = { sheets, painted: window.printPainted };
      setTimeout(() => window.dispatchEvent(new Event('afterprint')), 20);
    };
  });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.evaluate(() => {
    const e = window.__docs.current.view.engine;
    e.model.select(0); e.execute(() => e.model.replace(Array.from({ length: 140 }, (_, i) => `Paragraph ${i} holds a few more words to fill the line of text.`).join('\n')));
    e.model.select(e.model.text.indexOf('Paragraph 70 ')); e.revealCaret();
    const paint = e.paint;
    e.paint = function (options) { if (options?.printing) window.printPainted += options.pages?.length ?? options.canvases.length; return paint.call(this, options); };
  });
  const pageCount = await page.evaluate(() => window.__docs.current.view.engine.layout.pageCount);
  expect(pageCount).toBeGreaterThan(3);
  // The current page alone is painted for printing.
  const current = await printed(page, { range: 'current', copies: 1 });
  expect(current.painted).toBe(1);
  expect(current.sheets).toHaveLength(1);
  expect(current.sheets[0].tag).toBe('CANVAS');
  // Copies repeat one picture of the page, with the same pixels and size as the printed canvas.
  const copied = await printed(page, { range: 'current', copies: 3 });
  expect(copied.painted).toBe(1);
  expect(copied.sheets).toHaveLength(3);
  expect(copied.sheets.every(sheet => sheet.tag === 'IMG' && sheet.source === copied.sheets[0].source)).toBe(true);
  for (const sheet of copied.sheets) expect({ ...sheet, tag: 'CANVAS', source: null }).toEqual(current.sheets[0]);
  // All pages, twice: each page once in each copy, in order.
  const all = await printed(page, { range: 'all', copies: 1 });
  const twice = await printed(page, { range: 'all', copies: 2 });
  expect(all.painted).toBe(pageCount);
  expect(twice.painted).toBe(pageCount);
  expect(new Set(twice.sheets.map(sheet => sheet.source)).size).toBe(pageCount);
  expect(twice.sheets.map(sheet => ({ ...sheet, tag: 'CANVAS', source: null }))).toEqual([...all.sheets, ...all.sheets]);
  expect(errors).toEqual([]);
});
