import { test, expect } from '@playwright/test';
import { onTab } from './helpers/editor-tools.js';

// The Assistant's floating button stays over the page area: an open pane, beside the page or (on a phone) under it,
// keeps its controls uncovered — Replace All at the foot of Find and Replace, the style list of the Styles pane.
async function open(page) {
  await page.goto('/mock.html#/new');
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(input).toBeEditable({ timeout: 20000 });
  await input.fill('Some text to find and replace.');
  await expect(page.locator('.as-fab')).toBeVisible();
}
const overlapsOpenPane = page => page.evaluate(() => {
  const f = document.querySelector('.as-fab').getBoundingClientRect();
  const hit = el => { const b = el.getBoundingClientRect(); return b.width > 0 && !(b.right <= f.left || b.left >= f.right || b.bottom <= f.top || b.top >= f.bottom); };
  return [...document.querySelectorAll('.canvas-editor-content > :is(aside, section):not([hidden])')].filter(hit).map(el => el.className);
});
const insideHost = page => page.evaluate(() => {
  const f = document.querySelector('.as-fab').getBoundingClientRect(), h = document.querySelector('.canvas-host').getBoundingClientRect();
  return f.left >= h.left && f.right <= h.right && f.top >= h.top && f.bottom <= h.bottom;
});

test('on a desktop the button leaves an open Styles pane uncovered', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page);
  await onTab(page, 'home');
  await page.locator('#ribbon-panel-home').getByRole('button', { name: 'Styles Pane', exact: true }).click();
  await expect(page.locator('.styles-pane')).toBeVisible();
  await expect.poll(() => overlapsOpenPane(page)).toEqual([]);
  expect(await insideHost(page)).toBe(true);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
  test('the button leaves Replace All uncovered under the page', async ({ page }) => {
    await open(page);
    await onTab(page, 'home');
    await page.locator('#ribbon-panel-home').getByRole('button', { name: 'Replace', exact: true }).tap();
    const replaceAll = page.getByRole('button', { name: 'Replace all', exact: true });
    await expect(replaceAll).toBeVisible();
    await expect.poll(() => overlapsOpenPane(page)).toEqual([]);
    expect(await insideHost(page)).toBe(true);
    // A tap where Replace All shows reaches it, not the Assistant.
    const box = await replaceAll.boundingBox();
    expect(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.as-fab'), [box.x + box.width - 8, box.y + box.height / 2])).toBe(false);
  });
});
