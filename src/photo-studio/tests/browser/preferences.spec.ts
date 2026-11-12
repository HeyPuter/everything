// Preferences window, New Document window, Version History and recovery.
import { expect, test } from '@playwright/test';
import { boot, client, compositePixel, historyLabels, idle, openImage, run, start, tool, undo } from './helpers';

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test('preferences change the transparency grid, cursors and guides, and persist', async ({ page }) => {
  await openImage(page, 200, 150, '#808080');
  await page.evaluate(() => window.photoStudio.command('Guides', (d) => (d.guides = [{ orientation: 'vertical', position: 50 }])));
  await start(page, 'edit.preferences');
  const prefs = page.locator('dialog.prefs-window');
  await expect(prefs).toBeVisible();

  // Transparency & Gamut: a large, dark checkerboard.
  await prefs.getByRole('button', { name: 'Transparency & Gamut' }).click();
  await prefs.getByLabel('Grid size').selectOption('large');
  await prefs.getByLabel('Grid colors').selectOption('dark');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--checker-a').trim())).toBe('#666666');
  const period = await page.evaluate(() => parseFloat(window.photoStudio.root.style.getPropertyValue('--checker-period')) * window.photoStudio.zoom);
  expect(period).toBeCloseTo(32, 3);

  // Search finds settings across pages; guides turn red and dashed.
  await prefs.getByRole('searchbox', { name: 'Search settings' }).fill('guide');
  await expect(prefs.locator('.prefs-page-tag').first()).toBeVisible();
  await prefs.getByLabel('Guide style').selectOption('dashed');
  await prefs.locator('input[data-key="guideColor"]').evaluate((el: HTMLInputElement) => {
    el.value = '#ff0000';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const guide = page.locator('#overlay .guide').first();
  await expect.poll(() => guide.evaluate((el) => getComputedStyle(el).stroke)).toBe('rgb(255, 0, 0)');
  expect(await guide.evaluate((el) => getComputedStyle(el).strokeDasharray)).not.toBe('none');

  // Cursors: a precise painting cursor draws a crosshair instead of the tip.
  await prefs.getByRole('searchbox', { name: 'Search settings' }).fill('');
  await prefs.getByRole('button', { name: 'Cursors' }).click();
  await prefs.getByLabel('Painting cursor').selectOption('precise');
  await prefs.getByRole('button', { name: 'Done' }).click();
  await expect(prefs).toHaveCount(0);
  await tool(page, 'Brush Tool');
  const [x, y] = await client(page, 100, 75);
  await page.mouse.move(x, y);
  await page.mouse.move(x + 2, y + 2);
  await expect(page.locator('#screen-overlay .brush-cursor-cross')).toHaveCount(1);
  await expect(page.locator('#screen-overlay ellipse')).toHaveCount(0);

  // Stored and applied again after a reload.
  await page.reload();
  await page.waitForFunction(() => !!window.photoStudio?.renderer);
  const stored = await page.evaluate(() => ({ ...window.photoStudio.preferences }));
  expect(stored).toMatchObject({ checkerSize: 'large', checkerColors: 'dark', guideColor: '#ff0000', guideStyle: 'dashed', paintCursor: 'precise' });
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--checker-a').trim())).toBe('#666666');
});

test('cancel restores preferences changed in the window', async ({ page }) => {
  await start(page, 'edit.preferences');
  const prefs = page.locator('dialog.prefs-window');
  await prefs.getByRole('button', { name: 'Interface' }).click();
  await prefs.getByLabel('Color theme').selectOption('light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await prefs.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(() => window.photoStudio.preferences.theme)).toBe('dark');
});

test('New Document creates from a preset with artboards and a custom background', async ({ page }) => {
  await page.getByRole('button', { name: 'New document', exact: true }).click();
  const dialog = page.locator('dialog.newdoc-window');
  await dialog.getByRole('tab', { name: 'Web' }).click();
  await dialog.locator('[data-preset="web-link"]').click();
  await expect(dialog.getByLabel('Width (px)')).toHaveValue('1200');
  await dialog.getByLabel('Name', { exact: true }).fill('Card');
  await dialog.getByLabel('Artboards').check();
  await dialog.getByLabel('Background contents').selectOption('custom');
  await dialog.getByLabel('Custom background color').fill('#204080');
  // Inches keep the physical size.
  await dialog.getByLabel('Units', { exact: true }).selectOption('in');
  await expect(dialog.getByLabel('Width (in)')).toHaveValue('16.667');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('#document-name')).toHaveText('Card');
  await idle(page);
  const doc = await page.evaluate(() => {
    const d = window.photoStudio.doc;
    return { w: d.width, h: d.height, kind: d.layers[0].kind, artboard: d.layers[0].artboard };
  });
  expect(doc).toMatchObject({ w: 1200, h: 630, kind: 'group', artboard: { background: 'custom', color: '#204080' } });
  expect(await compositePixel(page, 600, 300)).toEqual([0x20, 0x40, 0x80, 255]);
  // The settings are offered again under Recent.
  await start(page, 'file.new');
  await expect(page.locator('dialog.newdoc-window [data-cat="recent"]')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('dialog.newdoc-window .newdoc-card')).toHaveCount(1);
});

test('Version History saves, previews and restores a version as a history step', async ({ page }) => {
  await openImage(page, 120, 80, '#336699');
  await start(page, 'file.save-version');
  await page.locator('#dialog').getByRole('button', { name: 'Save Version' }).click();
  const panel = page.locator('.versions-panel');
  await expect(panel.locator('.version-row')).toHaveCount(1);
  await run(page, 'adjust.invert');
  const inverted = await compositePixel(page, 10, 10);
  expect(inverted.slice(0, 3)).toEqual([0xcc, 0x99, 0x66]);

  await panel.locator('.version-row [data-version-act="preview"]').click();
  await expect(panel.locator('.versions-banner')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel.locator('.versions-banner')).toHaveCount(0);

  await panel.locator('.version-row [data-version-act="restore"]').click();
  await expect.poll(() => historyLabels(page)).toEqual(['Invert', expect.stringMatching(/^Restore Version/)]);
  await idle(page);
  expect((await compositePixel(page, 10, 10)).slice(0, 3)).toEqual([0x33, 0x66, 0x99]);
  await undo(page);
  expect((await compositePixel(page, 10, 10)).slice(0, 3)).toEqual([0xcc, 0x99, 0x66]);
});

test('unsaved documents are offered for recovery after the page closes', async ({ page }) => {
  await openImage(page, 64, 48, '#aa3355', 'unsaved.png');
  await run(page, 'adjust.invert');
  await run(page, 'file.autosave-now');
  await page.reload();
  await page.waitForFunction(() => !!window.photoStudio?.renderer);
  const dialog = page.locator('#dialog');
  await expect(dialog.getByRole('heading', { name: 'Restore Unsaved Documents?' })).toBeVisible();
  await expect(dialog.locator('.recovery-item')).toHaveCount(1);
  await dialog.getByRole('button', { name: 'Restore' }).click();
  await expect(page.locator('#document-name')).toHaveText('unsaved');
  await idle(page);
  expect((await compositePixel(page, 10, 10)).slice(0, 3)).toEqual([0x55, 0xcc, 0xaa]);
  await expect(page.locator('#dirty')).toBeVisible();
  // The record is consumed: another reload offers nothing.
  await page.reload();
  await page.waitForFunction(() => !!window.photoStudio?.renderer);
  await idle(page);
  await expect(page.locator('#dialog[open]')).toHaveCount(0);
});

test('Discard All asks first, naming how many documents are lost, and Go Back keeps them', async ({ page }) => {
  await openImage(page, 64, 48, '#aa3355', 'first.png');
  await run(page, 'adjust.invert');
  await openImage(page, 64, 48, '#3355aa', 'second.png');
  await run(page, 'adjust.invert');
  await run(page, 'file.autosave-now');
  await page.reload();
  await page.waitForFunction(() => !!window.photoStudio?.renderer);
  const dialog = page.locator('#dialog');
  await expect(dialog.locator('.recovery-item')).toHaveCount(2);
  await dialog.locator('.recovery-item input').first().uncheck();
  await dialog.getByRole('button', { name: 'Discard All' }).click();
  await expect(dialog.getByRole('heading', { name: 'Discard 2 Unsaved Documents?' })).toBeVisible();
  // The safe choice has focus, so Enter or Space does not discard.
  await expect(dialog.getByRole('button', { name: 'Go Back' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog.locator('.recovery-item')).toHaveCount(2);
  await expect(dialog.locator('.recovery-item input').first()).not.toBeChecked();
  // Escape on the question also goes back.
  await dialog.getByRole('button', { name: 'Discard All' }).click();
  await page.keyboard.press('Escape');
  await expect(dialog.locator('.recovery-item')).toHaveCount(2);
  await dialog.getByRole('button', { name: 'Discard All' }).click();
  await dialog.getByRole('button', { name: 'Discard 2 Documents' }).click();
  await expect(page.locator('#status')).toHaveText('Recovered documents discarded.');
  await page.reload();
  await page.waitForFunction(() => !!window.photoStudio?.renderer);
  await idle(page);
  await expect(page.locator('#dialog[open]')).toHaveCount(0);
});
