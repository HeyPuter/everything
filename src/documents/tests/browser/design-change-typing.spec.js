import { test, expect } from '@playwright/test';

const text = page => page.getByRole('textbox', { name: 'Document text' });

// A design change (theme, style set, watermark, page color) saves the package, rewrites it and reopens the
// result in a new editor. Text typed while that ran went into the editor being replaced and was lost.
test('text typed while a design change applies is kept', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await text(page).fill('Draft');
  await page.evaluate(() => {
    window.__opened = window.__docs.current.view.engine;
    let release; window.__release = new Promise(resolve => { release = resolve; }); window.__releaseNow = release;
    // The change waits (as reading and rewriting a long package does) until the test has typed.
    window.__applied = window.__docs.current.view.commands.changePackage(async blob => { await window.__release; return blob; });
  });
  await text(page).press('End');
  await text(page).pressSequentially(' more');
  await page.evaluate(() => window.__releaseNow());
  expect(await page.evaluate(() => window.__applied)).toBe(true);
  const after = await page.evaluate(() => { const e = window.__docs.current.view.engine; return { replaced: e !== window.__opened, text: e.model.text }; });
  expect(after).toEqual({ replaced: true, text: 'Draft more' });
  expect(errors).toEqual([]);
});
