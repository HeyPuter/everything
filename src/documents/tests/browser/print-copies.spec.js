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

test('a long document is printed a few pages at a time, each kept as a picture of the same pixels', async ({ page }) => {
  test.setTimeout(180000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    window.print = () => {
      const sheets = [...document.querySelectorAll('.print-stage-pages > *')].map(node => {
        const canvas = document.createElement('canvas');
        canvas.width = node.naturalWidth ?? node.width; canvas.height = node.naturalHeight ?? node.height;
        canvas.getContext('2d').drawImage(node, 0, 0);
        return { tag: node.tagName, width: node.style.width, height: node.style.height, pixels: canvas.toDataURL() };
      });
      window.sent = { sheets, painted: window.printPainted, peak: window.printPeak, alive: window.printAlive() };
      setTimeout(() => window.dispatchEvent(new Event('afterprint')), 20);
    };
  });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.evaluate(() => {
    const e = window.__docs.current.view.engine;
    e.model.select(0); e.execute(() => e.model.replace(Array.from({ length: 520 }, (_, i) => `Paragraph ${i} holds a few more words to fill the line of text.`).join('\n')));
    // The print-resolution canvases painted, and the most of them holding pixels at once.
    const made = [], paint = e.paint, sheets = e.printSheets;
    window.printPainted = 0; window.printPeak = 0;
    window.printAlive = () => made.filter(canvas => canvas.width > 0).length;
    e.paint = function (options) { if (options?.printing) window.printPainted += options.pages?.length ?? options.canvases.length; return paint.call(this, options); };
    e.printSheets = function (...args) {
      const result = sheets.apply(this, args);
      made.push(...result.filter(Boolean));
      window.printPeak = Math.max(window.printPeak, window.printAlive());
      return result;
    };
  });
  const pageCount = await page.evaluate(() => window.__docs.current.view.engine.layout.pageCount);
  expect(pageCount).toBeGreaterThan(10);
  await page.evaluate(() => { window.sent = null; });
  await page.getByRole('textbox', { name: 'Document text' }).press('ControlOrMeta+p');
  await expect.poll(() => page.evaluate(() => window.sent), { timeout: 60000 }).toBeTruthy();
  const sent = await page.evaluate(() => window.sent);
  expect(sent.sheets).toHaveLength(pageCount);
  expect(sent.painted).toBe(pageCount);
  expect(sent.sheets.every(sheet => sheet.tag === 'IMG')).toBe(true);
  // At most one batch of pages held its canvas at once, and none is held while the dialog shows.
  expect(sent.peak).toBeLessThanOrEqual(8);
  expect(sent.alive).toBe(0);
  // Each picture is the page as painted on its own, at the same size.
  for (const index of [0, 7, 8, pageCount - 1]) {
    const own = await page.evaluate(i => { const canvas = window.__docs.current.view.engine.printSheets([i])[i]; return { width: canvas.style.width, height: canvas.style.height, pixels: canvas.toDataURL() }; }, index);
    const { tag, ...sheet } = sent.sheets[index];
    expect(sheet).toEqual(own);
  }
  // Typing while the pages are being kept prints the document as it is then, not pages from before and after it.
  await page.evaluate(() => {
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (done, ...rest) { toBlob.call(this, blob => setTimeout(() => done(blob), 50), ...rest); };
    window.sent = null; window.printPainted = 0;
  });
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.press('ControlOrMeta+Home');
  await input.press('ControlOrMeta+p');
  await expect.poll(() => page.evaluate(() => window.printPainted)).toBeGreaterThan(0);
  await input.press('Enter');
  await expect.poll(() => page.evaluate(() => window.sent), { timeout: 60000 }).toBeTruthy();
  const edited = await page.evaluate(() => window.sent), editedCount = await page.evaluate(() => window.__docs.current.view.engine.layout.pageCount);
  expect(edited.sheets).toHaveLength(editedCount);
  // The pages kept before the edit were set aside and every page painted again.
  expect(edited.painted).toBeGreaterThan(editedCount);
  for (const index of [0, editedCount - 1]) {
    const own = await page.evaluate(i => { const canvas = window.__docs.current.view.engine.printSheets([i])[i]; return { width: canvas.style.width, height: canvas.style.height, pixels: canvas.toDataURL() }; }, index);
    const { tag, ...sheet } = edited.sheets[index];
    expect(sheet).toEqual(own);
  }
  expect(errors).toEqual([]);
});

test('preparing a long document for printing says so, can be canceled, and goes as the dialog opens', async ({ page }) => {
  test.setTimeout(180000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    window.printCalls = 0;
    // The notices showing when the print dialog would open.
    window.print = () => {
      window.printCalls++;
      window.sent = { notices: [...document.querySelectorAll('.toast:not(.leaving)')].map(node => node.textContent) };
      setTimeout(() => window.dispatchEvent(new Event('afterprint')), 20);
    };
  });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.evaluate(() => {
    const e = window.__docs.current.view.engine;
    e.model.select(0); e.execute(() => e.model.replace(Array.from({ length: 520 }, (_, i) => `Paragraph ${i} holds a few more words to fill the line of text.`).join('\n')));
    // Each page takes a moment to keep, as on a slower computer.
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (done, ...rest) { toBlob.call(this, blob => setTimeout(() => done(blob), 250), ...rest); };
  });
  const pageCount = await page.evaluate(() => window.__docs.current.view.engine.layout.pageCount);
  const input = page.getByRole('textbox', { name: 'Document text' });
  const notice = page.locator('.toast-root[role="status"] .toast:not(.leaving)', { hasText: 'Preparing pages for printing' });
  // The notice counts the pages kept, in the polite status region, and is gone when the dialog opens.
  await input.press('ControlOrMeta+p');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(new RegExp(`\\d+ of ${pageCount}`));
  await expect(notice).toContainText(`8 of ${pageCount}`);
  await expect.poll(() => page.evaluate(() => window.sent), { timeout: 60000 }).toBeTruthy();
  expect((await page.evaluate(() => window.sent)).notices.filter(text => text.includes('Preparing'))).toEqual([]);
  await expect(page.locator('.print-stage')).toHaveCount(0);
  await expect(notice).toHaveCount(0);
  // Cancel stops it: no dialog, no error, and printing can start again.
  await page.evaluate(() => { window.sent = null; });
  await input.press('ControlOrMeta+p');
  await notice.getByRole('button', { name: 'Cancel' }).click();
  await expect(notice).toHaveCount(0);
  await expect(page.locator('.print-stage')).toHaveCount(0);
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => window.printCalls)).toBe(1);
  await expect(page.locator('.toast-root')).not.toContainText('could not be prepared');
  await expect(page.locator('.canvas-message-error')).toHaveCount(0);
  await expect(page.locator('.toast-root')).toContainText('Printing canceled');
  await input.press('ControlOrMeta+p');
  await expect.poll(() => page.evaluate(() => window.printCalls), { timeout: 60000 }).toBe(2);
  await expect(notice).toHaveCount(0);
  expect(errors).toEqual([]);
});
