import { test, expect } from '@playwright/test';

// WCAG contrast of the colors an element shows: its text (or its edge over its own fill) against the first
// opaque background behind it.
const measure = (page, selector, { edge = false } = {}) => page.evaluate(([selector, edge]) => {
  const rgba = c => { const g = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d'); g.fillStyle = c; g.fillRect(0, 0, 1, 1); return [...g.getImageData(0, 0, 1, 1).data]; };
  const lum = ([r, g, b]) => [r, g, b].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  return [...document.querySelectorAll(selector)].map(node => {
    let back = node.parentElement, bg;
    while (back && rgba(bg = getComputedStyle(back).backgroundColor)[3] < 255) back = back.parentElement;
    const style = getComputedStyle(node);
    let fore = rgba(style.color);
    if (edge) { const line = rgba(style.borderTopColor), fill = rgba(style.backgroundColor), a = line[3] / 255; fore = [0, 1, 2].map(i => line[i] * a + fill[i] * (1 - a)); }
    const [hi, lo] = [lum(fore), lum(rgba(bg))].sort((x, y) => y - x);
    return { text: node.textContent, color: style.color, ratio: (hi + 0.05) / (lo + 0.05) };
  });
}, [selector, edge]);

async function open(page) {
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
}
async function stylesPane(page) {
  await page.getByRole('button', { name: 'Styles Pane' }).click();
  const preview = page.getByRole('complementary', { name: 'Styles pane' }).getByRole('checkbox', { name: 'Show styles as they look' });
  await preview.check();
  return page.getByRole('complementary', { name: 'Styles pane' });
}

test.describe('dark theme', () => {
  test.use({ colorScheme: 'dark', viewport: { width: 1440, height: 900 } });
  test('style samples in their own colors and the Automatic color chip stay readable', async ({ page }) => {
    await open(page);
    const pane = await stylesPane(page);
    // The Subtitle style's gray (#595959) is for white paper.
    await expect(pane.locator('.styles-pane-name', { hasText: 'Subtitle' })).toBeVisible();
    const samples = [...await measure(page, '.styles-pane-name'), ...await measure(page, '.ribbon-style-sample')];
    expect(samples.map(s => s.text)).toContain('Subtitle');
    for (const sample of samples) expect(sample.ratio, sample.text).toBeGreaterThanOrEqual(4.5);
    // The Font dialog's Automatic color is a black chip: its edge must stand out from the dark dialog.
    await page.getByRole('textbox', { name: 'Document text' }).press('ControlOrMeta+d');
    await expect(page.getByRole('button', { name: 'Font color' })).toContainText('Automatic');
    const chips = await measure(page, '.ed-font-chip', { edge: true });
    expect(chips.length).toBeGreaterThan(0);
    for (const chip of chips) expect(chip.ratio).toBeGreaterThanOrEqual(3);
  });
});

test('the light theme shows a style sample in the style’s own color', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await open(page);
  const pane = await stylesPane(page);
  await expect(pane.locator('.styles-pane-name', { hasText: 'Subtitle' })).toHaveCSS('color', 'rgb(89, 89, 89)');
});
