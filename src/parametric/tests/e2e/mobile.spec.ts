import { expect, test } from '@playwright/test';
import { openApp, waitForFeature } from './helpers';

test('mobile layout opens the design tree as a sheet and has no page scroll', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await page.getByRole('button', { name: 'Show design tree' }).click();
  await waitForFeature(page, 'Fillet1');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  // Share is in the File menu on phones; the title bar keeps the room for the part name.
  const share = page.locator('.titlebar [data-cmd="share"]');
  await expect(share).toHaveCount(1);
  await expect(share).toBeHidden();
  // The sheet (with its close button) passes axe.
  await page.addScriptTag({ path: 'node_modules/axe-core/axe.min.js' });
  const violations = await page.evaluate(async () => {
    // @ts-expect-error axe is injected above
    const r = await window.axe.run(document, { resultTypes: ['violations'] });
    return r.violations.filter((v: { impact: string }) => v.impact === 'serious' || v.impact === 'critical').map((v: { id: string }) => v.id);
  });
  expect(violations).toEqual([]);
  await page.getByRole('treeitem', { name: 'Fillet1' }).dblclick();
  await expect(page.getByRole('heading', { name: 'Fillet1' })).toBeVisible();
});

test('tablet title bar keeps every control on screen', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  const offscreen = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.titlebar button, .titlebar a, .titlebar input')]
    .filter((el) => el.offsetParent && el.getBoundingClientRect().right > window.innerWidth)
    .map((el) => el.getAttribute('aria-label') ?? el.textContent));
  expect(offscreen).toEqual([]);
  expect((await page.locator('.doc-title').boundingBox())!.width).toBeGreaterThan(40);
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'File' })).toBeVisible();
});
