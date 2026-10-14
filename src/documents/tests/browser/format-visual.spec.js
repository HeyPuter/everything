import { test, expect } from '@playwright/test';
import { onTab } from './helpers/editor-tools.js';

test.setTimeout(240000);
const ribbon = (page, name) => page.locator('.ribbon-card').getByRole('button', { name, exact: true });

// Each Format dialog and the Styles pane fit the window at desktop and phone widths; screenshots go to test-results.
for (const [width, height] of [[1440, 900], [390, 844]]) {
  test(`Format dialogs fit a ${width}px window`, async ({ page }, info) => {
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.setViewportSize({ width, height });
    await page.goto('/playground.html');
    await page.getByRole('button', { name: 'New', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Document text' });
    await input.fill('First line of text\nSecond line of text');
    await input.evaluate(el => { el.setSelectionRange(0, 5); el.dispatchEvent(new Event('select', { bubbles: true })); });
    await onTab(page, 'home');
    const shots = [
      ['font', () => input.press('ControlOrMeta+d'), 'Font'],
      ['paragraph', () => page.evaluate(() => document.querySelector('[aria-label="Paragraph Settings"]')?.click()), 'Paragraph'],
      ['borders', async () => { await page.evaluate(() => document.querySelector('[aria-label="Border options"]')?.click()); await page.getByRole('menuitem', { name: 'Borders and Shading…' }).click(); }, 'Borders and Shading'],
      ['bullet', async () => { await page.evaluate(() => document.querySelector('[aria-label="Bullet Library"]')?.click()); await page.getByRole('menuitem', { name: 'Define New Bullet…' }).click(); }, 'Define New Bullet'],
      ['multilevel', async () => { await page.evaluate(() => document.querySelector('[aria-label="Multilevel List"]')?.click()); await page.getByRole('menuitem', { name: 'Define New Multilevel List…' }).click(); }, 'Define New Multilevel List'],
    ];
    for (const [name, open, title] of shots) {
      await open();
      const dialog = page.getByRole('dialog', { name: title });
      await expect(dialog).toBeVisible();
      await page.waitForTimeout(300);
      const box = await dialog.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(-1); expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
      expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: info.outputPath(`${name}-${width}.png`) });
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    }
    // The Paragraph dialog's Tabs… and the Styles pane.
    await page.evaluate(() => document.querySelector('[aria-label="Paragraph Settings"]')?.click());
    await page.getByRole('dialog', { name: 'Paragraph' }).getByRole('button', { name: 'Tabs…' }).click();
    await expect(page.getByRole('dialog', { name: 'Tabs' })).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: info.outputPath(`tabs-${width}.png`) });
    await page.keyboard.press('Escape');
    await page.evaluate(() => document.querySelector('[aria-label="Styles Pane"]')?.click());
    const pane = page.getByRole('complementary', { name: 'Styles pane' });
    await expect(pane).toBeVisible();
    const paneBox = await pane.boundingBox();
    expect(paneBox.x + paneBox.width).toBeLessThanOrEqual(width + 1);
    await page.screenshot({ path: info.outputPath(`styles-pane-${width}.png`) });
    expect(errors).toEqual([]);
  });
}
