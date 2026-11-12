// The workspace chrome on touch screens, tablets and phones, plus menus and
// states that are easy to leave behind (listeners, errors, empty states).
import { test, expect } from '@playwright/test';
import { boot, openImage } from './helpers';

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 240, 160, '#808080', 'touch.png');
});

test('the status bar info menu takes Home and End, and a closed menu leaves nothing behind', async ({ page }) => {
  const button = page.locator('#doc-info');
  const menu = page.locator('.status-info-menu');
  // Opened and closed with the keyboard, then opened again.
  await button.click();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await button.click();
  await expect(menu).toBeVisible();
  const items = menu.locator('.menu-item');
  await page.keyboard.press('End');
  await expect(items.last()).toBeFocused();
  await page.keyboard.press('Home');
  await expect(items.first()).toBeFocused();
  // Pressing an item of the new menu: the earlier menu's listener used to
  // mark the button collapsed while this menu was still open.
  const box = (await items.nth(1).boundingBox())!;
  await page.mouse.move(box.x + 10, box.y + box.height / 2);
  await page.mouse.down();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await page.mouse.up();
  await expect(menu).toHaveCount(0);
  await expect(button).toHaveAttribute('aria-expanded', 'false');
});

for (const viewport of [{ width: 1024, height: 768 }, { width: 768, height: 1024 }]) {
  test.describe(`on a ${viewport.width}×${viewport.height} touch screen`, () => {
    test.use({ viewport, hasTouch: true });
    test('bar, tab and panel controls are at least 24 px tall and wide', async ({ page }) => {
      const small = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('.topbar, .optionsbar, .toolbar, .document-tabs, .statusbar, .dock-column, .dock-strip')]
          .flatMap((root) => [...root.querySelectorAll<HTMLElement>('button, select, input:not([type="hidden"]), [role="tab"]')])
          // Checkboxes sit in their (larger) labels; the color chips' touch area extends past their glyph.
          .filter((el) => el.getClientRects().length && !el.closest('.color-chips, .color-chip-pair, .sr-only, label') && !el.classList.contains('sr-only'))
          .map((el) => ({ el, r: el.getBoundingClientRect() }))
          .filter(({ r }) => Math.min(r.width, r.height) < 24 - 0.5)
          .map(({ el, r }) => `${el.getAttribute('aria-label') ?? el.id ?? el.className} ${Math.round(r.width)}×${Math.round(r.height)}`),
      );
      expect(small).toEqual([]);
      // The chips' touch areas: 24 px or more around their glyph.
      for (const sel of ['.chip-default', '.chip-swap', '.fg-big']) {
        const after = await page.locator(sel).first().evaluate((el) => { const s = getComputedStyle(el, '::after'); return s.content !== 'none' ? parseFloat(s.top) : 0; });
        const box = (await page.locator(sel).first().boundingBox())!;
        expect(Math.min(box.width, box.height) - 2 * after, sel).toBeGreaterThanOrEqual(24);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    });
  });
}
