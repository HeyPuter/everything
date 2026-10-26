import { test, expect } from '@playwright/test';
import { menuBarMenu } from './helpers/editor-tools.js';

// WCAG contrast of the colors an element shows: its text (or its edge over its own fill) against the first
// opaque background behind it (or under it, with own: an element that fills its own background).
const measure = (page, selector, { edge = false, own = false } = {}) => page.evaluate(([selector, edge, own]) => {
  const rgba = c => { const g = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d'); g.fillStyle = c; g.fillRect(0, 0, 1, 1); return [...g.getImageData(0, 0, 1, 1).data]; };
  const lum = ([r, g, b]) => [r, g, b].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  return [...document.querySelectorAll(selector)].map(node => {
    let back = own ? node : node.parentElement, bg;
    while (back && rgba(bg = getComputedStyle(back).backgroundColor)[3] < 255) back = back.parentElement;
    const style = getComputedStyle(node);
    let fore = rgba(style.color);
    if (edge) { const line = rgba(style.borderTopColor), fill = rgba(style.backgroundColor), a = line[3] / 255; fore = [0, 1, 2].map(i => line[i] * a + fill[i] * (1 - a)); }
    const [hi, lo] = [lum(fore), lum(rgba(bg))].sort((x, y) => y - x);
    return { text: node.textContent, color: style.color, ratio: (hi + 0.05) / (lo + 0.05) };
  });
}, [selector, edge, own]);

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
  test('the chosen style in Format > Style and the chosen level in Define New Multilevel List stay readable', async ({ page }) => {
    await open(page);
    await (await menuBarMenu(page, 'Format')).getByRole('menuitem', { name: 'Style…', exact: true }).click();
    await expect(page.locator('.fmt-listbox-item[aria-selected="true"]')).toBeVisible();
    const chosen = await measure(page, '.fmt-listbox-item[aria-selected="true"] *');
    expect(chosen.length).toBeGreaterThan(0);
    for (const item of chosen) expect(item.ratio, item.text).toBeGreaterThanOrEqual(4.5);
    await page.keyboard.press('Escape');
    await (await menuBarMenu(page, 'Format')).getByRole('menuitem', { name: 'Bullets and Numbering…' }).click();
    await page.getByRole('dialog', { name: 'Bullets and Numbering' }).getByRole('tab', { name: 'Multilevel' }).click();
    await page.getByRole('button', { name: 'Define New Multilevel List…' }).click();
    await expect(page.locator('.fmt-level-item[aria-selected="true"]')).toBeVisible();
    for (const item of await measure(page, '.fmt-level-item[aria-selected="true"]', { own: true })) expect(item.ratio, item.text).toBeGreaterThanOrEqual(4.5);
  });
  test('the None choice in Bullets and Numbering stays readable on its white tile', async ({ page }) => {
    await open(page);
    await (await menuBarMenu(page, 'Format')).getByRole('menuitem', { name: 'Bullets and Numbering…' }).click();
    const none = await measure(page, '.fmt-list-tile .list-library-none');
    expect(none.length).toBeGreaterThan(0);
    for (const item of none) expect(item.ratio).toBeGreaterThanOrEqual(4.5);
  });
});

test('the light theme shows a style sample in the style’s own color', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await open(page);
  const pane = await stylesPane(page);
  await expect(pane.locator('.styles-pane-name', { hasText: 'Subtitle' })).toHaveCSS('color', 'rgb(89, 89, 89)');
});
