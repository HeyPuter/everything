import { test, expect } from '@playwright/test';

async function setup(page) {
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill('Selected words stay selected.');
  await input.evaluate(el => { el.setSelectionRange(0, 8); el.dispatchEvent(new Event('select', { bubbles: true })); });
  return input;
}
const tool = (page, name) => page.getByRole('button', { name, exact: true });
const palette = (page, name) => page.getByRole('menu', { name, exact: true });

test('anchored swatches preserve selection, show current colors, and support undo and dismissal', async ({ page }, testInfo) => {
  const input = await setup(page);
  const color = tool(page, 'Text color'), highlight = tool(page, 'Text highlight');
  await color.click();
  const menu = palette(page, 'Text color');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(color).toHaveAttribute('aria-expanded', 'true');
  const a = await color.boundingBox(), p = await menu.boundingBox();
  expect(p.y).toBeGreaterThanOrEqual(a.y + a.height);
  expect(Math.abs(p.x - a.x)).toBeLessThan(2);
  await menu.getByRole('menuitemradio', { name: 'Red', exact: true }).click();
  await expect(input).toBeFocused();
  expect(await input.evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual([0, 8]);
  await expect(color).toHaveAttribute('title', 'Text color: #FF0000');
  await expect(color.locator('.canvas-color-indicator')).toHaveCSS('background-color', 'rgb(255, 0, 0)');
  await tool(page, 'Undo').click(); await expect(color).toHaveAttribute('title', 'Text color: Automatic');
  await tool(page, 'Redo').click(); await expect(color).toHaveAttribute('title', 'Text color: #FF0000');
  await highlight.click(); await palette(page, 'Text highlight').getByRole('menuitemradio', { name: 'Yellow', exact: true }).click();
  await expect(input).toBeFocused(); await expect(highlight).toHaveAttribute('title', 'Text highlight: Yellow');
  await highlight.click(); await expect(page.getByRole('menuitemradio', { name: 'Yellow', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.screenshot({ path: testInfo.outputPath('highlight-palette.png') });
  await color.click(); await expect(palette(page, 'Text highlight')).toHaveCount(0);
  await expect(menu.getByRole('menuitemradio', { name: 'Red', exact: true })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('text-color-palette.png') });
  await menu.getByLabel('Custom text color hex value').fill('#123456');
  // A palette the pointer opened closes back to where the keyboard was: here the document.
  await page.keyboard.press('Escape'); await expect(input).toBeFocused();
  await expect(color).toHaveAttribute('title', 'Text color: #FF0000');
  await color.click(); await color.click(); await expect(menu).toHaveCount(0);
  await highlight.click(); await page.getByRole('textbox', { name: 'Document name' }).click();
  await expect(palette(page, 'Text highlight')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Document name' })).toBeFocused();
  await expect(highlight).toHaveAttribute('title', 'Text highlight: Yellow');
});

test('supports keyboard swatches for both palettes without dialogs', async ({ page }) => {
  const input = await setup(page), color = tool(page, 'Text color');
  await color.focus(); await color.press('ArrowDown');
  await expect(page.getByRole('menuitemradio', { name: 'Automatic', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitemradio', { name: 'Black', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitemradio', { name: 'Red', exact: true })).toBeFocused();
  await page.keyboard.press('Enter'); await expect(input).toBeFocused();
  await expect(color).toHaveAttribute('title', 'Text color: #FF0000');
  // The Format menu no longer nests the palettes (it follows the desktop word processor's Format
  // menu); the highlight palette is reached from its ribbon button with the keyboard instead.
  const item = tool(page, 'Text highlight');
  await item.focus(); await item.press('ArrowDown');
  const menu = palette(page, 'Text highlight');
  await expect(menu).toBeVisible(); await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.keyboard.press('Escape'); await expect(item).toBeFocused();
  await item.press('ArrowDown');
  await menu.getByRole('menuitemradio', { name: 'Dark blue', exact: true }).click();
  await expect(input).toBeFocused(); await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(tool(page, 'Text highlight')).toHaveAttribute('title', 'Text highlight: Dark blue');
  await expect(tool(page, 'Text highlight').locator('.canvas-color-indicator')).toHaveCSS('background-color', 'rgb(0, 0, 139)');
});

test.describe('Touch palettes', () => {
  test.use({ viewport: { width: 375, height: 720 }, isMobile: true, hasTouch: true, colorScheme: 'dark', reducedMotion: 'reduce' });
  test('keeps both palettes within a narrow viewport in dark mode', async ({ page }, testInfo) => {
    await setup(page);
    for (const name of ['Text color', 'Text highlight']) {
      await tool(page, name).tap();
      const menu = palette(page, name), box = await menu.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(8); expect(box.x + box.width).toBeLessThanOrEqual(367);
      expect(box.y).toBeGreaterThanOrEqual(8); expect(box.y + box.height).toBeLessThanOrEqual(712);
      await page.screenshot({ path: testInfo.outputPath(`${name.replaceAll(' ', '-')}-mobile.png`) });
      await menu.getByRole('menuitemradio', { name: 'Yellow', exact: true }).click();
    }
  });
});
