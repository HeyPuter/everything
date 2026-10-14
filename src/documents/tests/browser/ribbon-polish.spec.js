import { test, expect } from '@playwright/test';

const text = page => page.getByRole('textbox', { name: 'Document text' });
const tab = (page, name) => page.getByRole('tab', { name, exact: true });
const gallery = page => page.getByRole('listbox', { name: 'Styles' });
async function openEditor(page, width = 1440) {
  await page.setViewportSize({ width, height: 800 });
  await page.goto('/mock.html#/new');
  await page.locator('.ribbon-card').waitFor();
  await expect(page.locator('#ribbon-panel-home button[aria-label="Bold"]')).toBeEnabled();
}
/** The office drawing a ribbon command shows, as markup, to compare two commands' icons. */
const iconOf = (page, name) => page.locator('.ribbon-panel:not([hidden])').getByRole('button', { name, exact: true }).locator('svg.ico').first().innerHTML();

test('style gallery samples use each style\'s font and follow a modified style', async ({ page }) => {
  await openEditor(page);
  const sample = gallery(page).getByRole('option', { name: 'Heading 1' }).locator('.ribbon-style-sample');
  expect(await sample.evaluate(el => getComputedStyle(el).fontFamily)).not.toMatch(/Georgia/);
  await gallery(page).getByRole('option', { name: 'Heading 1' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Modify…' }).click();
  await page.getByRole('combobox', { name: 'Style italic' }).selectOption('true');
  await page.getByRole('textbox', { name: 'Style text color' }).fill('C00000');
  await page.getByRole('dialog').getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(sample).toHaveCSS('font-style', 'italic');
  await expect(sample).toHaveCSS('color', 'rgb(192, 0, 0)');
});

test('menus opened from the ribbon draw every icon from the ribbon\'s own set', async ({ page }) => {
  await openEditor(page);
  await page.getByRole('button', { name: 'Paste options', exact: true }).click();
  const icons = page.getByRole('menu', { name: 'Paste options' }).locator('.menu-icon svg');
  await expect(icons).toHaveCount(2);
  expect(await icons.evaluateAll(list => list.map(svg => svg.classList.contains('ico')))).toEqual([true, true]);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'File', exact: true }).click();
  const fileIcons = page.getByRole('menu', { name: 'File' }).locator('.menu-icon svg');
  expect(await fileIcons.evaluateAll(list => list.every(svg => svg.classList.contains('ico')))).toBe(true);
});

test('related table, picture and shape commands have distinct icons', async ({ page }) => {
  await openEditor(page);
  await tab(page, 'Insert').click();
  await page.getByRole('button', { name: 'Insert table', exact: true }).click();
  await page.getByRole('menuitem', { name: '3 columns, 3 rows' }).click();
  await tab(page, 'Table Layout').click();
  expect(await iconOf(page, 'Paragraph After')).not.toBe(await iconOf(page, 'Insert Below'));
  expect(await iconOf(page, 'Paragraph Before')).not.toBe(await iconOf(page, 'Paragraph After'));
  expect(await iconOf(page, 'Merge Below')).not.toBe(await iconOf(page, 'Merge Cells'));
  const deleteTable = await page.evaluate(async () => (await import('/src/ui/command-icons.js')).commandIconBody('deleteTable'));
  await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.press('Enter');
  await tab(page, 'Insert').click();
  await page.getByRole('button', { name: 'Shapes', exact: true }).click();
  await page.locator('.shape-gallery-item').nth(2).click();
  await page.locator('canvas.canvas-page').first().click({ position: { x: 200, y: 400 } });
  await tab(page, 'Shape Format').click();
  expect(await iconOf(page, 'Delete Shape')).not.toBe(deleteTable);
});

test('large commands, split buttons and titled fields fit inside their ribbon group', async ({ page }) => {
  await openEditor(page);
  for (const name of ['Home', 'Insert', 'Layout', 'References', 'Mailings', 'Review', 'View']) {
    await tab(page, name).click();
    const overflow = await page.evaluate(() => {
      const panel = document.querySelector('.ribbon-panel:not([hidden])'), bad = [];
      for (const node of panel.querySelectorAll('.ribbon-large, .ribbon-split.is-large, .ribbon-spin-group')) {
        if (node.closest('[hidden]') || node.closest('.ribbon-split') && node.matches('.ribbon-large')) continue;
        const box = node.getBoundingClientRect(), group = node.closest('.ribbon-group').getBoundingClientRect();
        const contentBottom = Math.max(...[...node.querySelectorAll('.ribbon-large-label, input')].map(child => child.getBoundingClientRect().bottom), box.bottom);
        if (box.top < group.top - 0.5 || contentBottom > group.bottom + 0.5) bad.push(node.getAttribute('aria-label') || node.className);
      }
      return bad;
    });
    expect(overflow, name).toEqual([]);
  }
});

test('the Header & Footer tab sets its position labels and close command without wrapping into each other', async ({ page }) => {
  await openEditor(page);
  await tab(page, 'Insert').click();
  await page.getByRole('button', { name: 'Header', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit Header' }).click();
  await expect(tab(page, 'Header & Footer')).toHaveAttribute('aria-selected', 'true');
  const panel = page.locator('.ribbon-panel:not([hidden])');
  for (const label of ['Header from Top', 'Footer from Bottom']) {
    const height = await panel.locator('.ribbon-spin-label', { hasText: label }).evaluate(el => el.getBoundingClientRect().height);
    expect(height, label).toBeLessThan(20);
  }
  const lefts = await panel.locator('.ribbon-spin input').evaluateAll(list => list.map(input => Math.round(input.getBoundingClientRect().left)));
  expect(new Set(lefts).size).toBe(1);
  const close = panel.getByRole('button', { name: 'Close Header and Footer', exact: true });
  const lines = await close.locator('.ribbon-large-label').evaluate(el => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
  expect(lines).toBe(2);
});

test('a collapsed Styles group opens a styled gallery with room for several styles', async ({ page }) => {
  await openEditor(page, 820);
  const styles = page.locator('#ribbon-panel-home .ribbon-collapsed[aria-label="Styles"]');
  await expect(styles).toBeVisible();
  await styles.click();
  const tiles = page.locator('.ribbon-flyout .ribbon-style');
  await expect(tiles.first()).toHaveCSS('display', 'flex');
  expect(await page.locator('.ribbon-flyout .ribbon-gallery').evaluate(el => Math.round(el.getBoundingClientRect().width / 99))).toBeGreaterThan(2);
  const flyout = await page.locator('.ribbon-flyout').boundingBox();
  expect(flyout.x + flyout.width).toBeLessThanOrEqual(820);
});

test('phones keep the font name box, and ribbon focus rings stay inside the ribbon', async ({ page }) => {
  await openEditor(page, 390);
  await expect(page.locator('#ribbon-panel-home .ribbon-font')).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 800 });
  await text(page).focus();
  await tab(page, 'Home').focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('button', { name: 'Paste', exact: true })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Paste', exact: true })).toHaveCSS('outline-offset', '-2px');
});
