import { test, expect } from '@playwright/test';

// A tapped command on a touch screen kept its hover tint until the next tap, looking pressed or stuck. Hover tints
// show only where a pointer can hover; a mouse still gets them.
const bg = locator => locator.evaluate(b => getComputedStyle(b).backgroundColor);
async function open(page) {
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('textbox', { name: 'Document text' })).toBeEditable({ timeout: 20000 });
  await page.evaluate(() => { const e = window.__docs.current.view.engine; e.model.replace('Hello world.'); e.relayout(); e.model.select(0, 5); e.syncInput(); });
}

test.describe('on a touch screen', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('a tapped command, tab or header button keeps no hover tint', async ({ page }) => {
    await open(page);
    const home = page.locator('#ribbon-panel-home');
    for (const control of [home.getByRole('button', { name: 'Increase Font Size', exact: true }), home.getByRole('button', { name: 'Decrease Indent', exact: true }),
      page.locator('#ribbon-tab-insert'), page.getByRole('button', { name: 'Save', exact: true }).first()]) {
      await control.scrollIntoViewIfNeeded();
      const before = await bg(control);
      await control.tap();
      expect(await control.evaluate(b => b.matches(':hover'))).toBe(true);
      expect(await bg(control)).toBe(before);
      if (await page.locator('#ribbon-tab-home').getAttribute('aria-selected') !== 'true') await page.locator('#ribbon-tab-home').tap();
    }
  });
});

test('a mouse over a command still tints it', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await open(page);
  const button = page.locator('#ribbon-panel-home').getByRole('button', { name: 'Increase Font Size', exact: true });
  const before = await button.evaluate(b => getComputedStyle(b).backgroundImage + getComputedStyle(b).backgroundColor);
  await button.hover();
  expect(await button.evaluate(b => getComputedStyle(b).backgroundImage + getComputedStyle(b).backgroundColor)).not.toBe(before);
});
