import { test, expect } from '@playwright/test';

/** The contrast of a note's text against what is painted behind it (its row, the menu, the page), per WCAG 2.2. */
const noteContrast = note => note.evaluate(node => {
  // A row the list redraws meanwhile has no style to read: 0, and the poll reads it again.
  if (!node.isConnected || !getComputedStyle(node).color) return 0;
  const rgba = text => { const [r, g, b, a = 1] = text.match(/[\d.]+/g).map(Number); return { r, g, b, a }; };
  const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
  const layers = [];
  for (let at = node; at; at = at.parentElement) {
    const fill = rgba(getComputedStyle(at).backgroundColor);
    if (fill.a > 0) layers.unshift(fill);
    if (fill.a >= 1) break;
  }
  const back = layers.reduce((under, top) => over(top, under), { r: 255, g: 255, b: 255, a: 1 });
  const fore = over(rgba(getComputedStyle(node).color), back);
  const lum = ({ r, g, b }) => [r, g, b].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const [light, dark] = [lum(fore), lum(back)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
});

for (const scheme of ['light', 'dark']) {
  test(`the font list’s notes stay readable on the chosen and pointed-at fonts (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/mock.html#/new');
    await expect(page.locator('.ribbon-card').getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
    await page.locator('.ribbon-card [aria-label="Latin font family"]').first().click();
    const chosen = page.locator('.font-choice[aria-pressed="true"]');
    await expect(chosen).toBeVisible();
    // Small (10 px) text needs 4.5:1.
    await expect.poll(() => noteContrast(chosen.locator('small'))).toBeGreaterThanOrEqual(4.5);
    const other = page.locator('.font-choice[aria-pressed="false"]').first();
    await other.hover();
    await expect.poll(() => noteContrast(other.locator('small'))).toBeGreaterThanOrEqual(4.5);
  });
}
