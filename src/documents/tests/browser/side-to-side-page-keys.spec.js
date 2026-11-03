import { test, expect } from '@playwright/test';

// Side to Side lays the pages out in a row. Page Down measured a screen down the column, which the
// whole row never reaches, so one press went to the end of the document; it now turns to the pages
// after those the window shows, and the caret keeps its place on the page.
test('Page Down and Page Up in Side to Side turn a screen of pages', async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill(Array.from({ length: 200 }, (_, i) => `Paragraph ${i} ` + 'lorem ipsum dolor sit amet '.repeat(6)).join('\n'));
  await page.locator('#ribbon-tab-view').click();
  await page.locator('.ribbon-card').getByRole('button', { name: 'Side to Side', exact: true }).click();
  await expect(page.locator('.canvas-pages')).toHaveClass(/is-side-to-side/);
  const pages = await page.locator('canvas.canvas-page').count();
  expect(pages).toBeGreaterThan(10);
  await input.focus(); await input.press('ControlOrMeta+Home');
  // Pages the window shows whole.
  const shown = await page.evaluate(() => { const host = document.querySelector('.canvas-host').getBoundingClientRect(); return [...document.querySelectorAll('canvas.canvas-page')].filter(c => { const r = c.getBoundingClientRect(); return r.left >= host.left - 1 && r.right <= host.right + 1; }).length; });
  expect(shown).toBeGreaterThan(0);
  const caretPage = () => input.evaluate(el => {
    const text = el.value, at = el.selectionStart, paragraph = text.slice(0, at).split('\n').length - 1;
    return { at, paragraph };
  });
  await input.press('PageDown');
  const down = await caretPage();
  // The first paragraph of the page after those shown (each page holds about eleven paragraphs).
  expect(down.at).toBeLessThan((await input.inputValue()).length);
  expect(down.paragraph).toBeGreaterThan(shown * 11 - 3);
  expect(down.paragraph).toBeLessThan(shown * 11 + 12);
  // The page the caret went to is on screen.
  await expect.poll(() => page.evaluate(() => { const host = document.querySelector('.canvas-host').getBoundingClientRect(); return [...document.querySelectorAll('canvas.canvas-page')].findIndex(c => c.getBoundingClientRect().left >= host.left - 1); })).toBe(shown);
  await input.press('PageUp');
  expect((await caretPage()).at).toBe(0);
});

// The rulers follow the first page in view. In a row of pages that was the first page of the document
// even once scrolled away to the left: the horizontal ruler went off screen with it.
test('the rulers follow the page in view when Side to Side scrolls sideways', async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill(Array.from({ length: 120 }, (_, i) => `Paragraph ${i} ` + 'lorem ipsum dolor sit amet '.repeat(6)).join('\n'));
  await page.locator('#ribbon-tab-view').click();
  await page.locator('.ribbon-card').getByRole('button', { name: 'Side to Side', exact: true }).click();
  await expect(page.locator('.canvas-pages')).toHaveClass(/is-side-to-side/);
  const ruler = page.getByRole('group', { name: 'Horizontal ruler' });
  await expect(ruler).toBeVisible();
  await page.locator('.canvas-host').evaluate(host => { host.scrollLeft = host.querySelectorAll('canvas.canvas-page')[4].offsetLeft - 24; });
  await expect.poll(async () => {
    const [rulerBox, pageBox] = await Promise.all([ruler.boundingBox(), page.locator('canvas.canvas-page').nth(4).boundingBox()]);
    return rulerBox && pageBox ? Math.round(Math.abs(rulerBox.x - pageBox.x)) : null;
  }).toBe(0);
});
