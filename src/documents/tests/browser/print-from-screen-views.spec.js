import { test, expect } from '@playwright/test';

// File > Print counted the screen's pages. In Web Layout and Draft those are strips of the window's
// height, so a five-page document offered "All pages (2)" and printed only its first two pages, and
// "Current page" printed the page of the caret's strip. Print now counts the printed pages.
test.use({ viewport: { width: 1440, height: 900 } });

test('File > Print from Web Layout and Draft offers and prints every printed page', async ({ page }) => {
  test.setTimeout(120000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    window.print = () => {
      window.sent = document.querySelectorAll('.print-stage-pages > *').length;
      setTimeout(() => window.dispatchEvent(new Event('afterprint')), 20);
    };
  });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  const pageCount = await page.evaluate(() => {
    const e = window.__docs.current.view.engine;
    e.model.select(0); e.execute(() => e.model.replace(Array.from({ length: 140 }, (_, i) => `Paragraph ${i} holds a few more words to fill the line of text.`).join('\n')));
    e.model.select(e.model.text.indexOf('Paragraph 100 ')); e.revealCaret();
    return e.layout.pageCount;
  });
  expect(pageCount).toBeGreaterThan(3);
  const caretPage = await page.evaluate(() => window.__docs.current.view.engine.caretPageIndex + 1);
  for (const view of ['Web Layout', 'Draft']) {
    await page.locator('#ribbon-tab-view').click();
    await page.locator('.ribbon-card').getByRole('button', { name: view, exact: true }).click();
    expect(await page.evaluate(() => window.__docs.current.view.engine.layout.pageCount)).toBeLessThan(pageCount);
    await page.getByRole('button', { name: 'File', exact: true }).click();
    await page.getByRole('tab', { name: 'Print' }).click();
    const pages = page.getByRole('combobox', { name: 'Pages' });
    await expect(pages.locator('option[value="all"]')).toHaveText(`All pages (${pageCount})`);
    await expect(pages.locator('option[value="current"]')).toHaveText(`Current page (${caretPage})`);
    await page.evaluate(() => { window.sent = null; });
    await page.locator('.bs-print-button').click();
    await expect.poll(() => page.evaluate(() => window.sent)).toBe(pageCount);
  }
  expect(errors).toEqual([]);
});
