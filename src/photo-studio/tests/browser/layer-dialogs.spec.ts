// New Layer, New Group and Duplicate Layer dialogs, and layer color labels.
import { test, expect, type Page } from '@playwright/test';
import { boot, idle, layerPixel, openImage, start } from './helpers';

const dialog = (page: Page) => page.locator('#dialog[open]');
const current = (page: Page) =>
  page.evaluate(() => {
    const l = window.photoStudio.layer!;
    return {
      name: l.name,
      kind: l.kind,
      blend: l.blend,
      opacity: l.opacity,
      color: l.colorLabel,
      clipped: !!l.clipped,
    };
  });

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 120, 80, '#3366cc', 'base.png');
});

test('New Layer sets mode, opacity, color label, clipping and a neutral fill', async ({ page }) => {
  await start(page, 'layer.new');
  await expect(dialog(page)).toBeVisible();
  const neutral = dialog(page).locator('input[type=checkbox][name=neutral]');
  // Normal mode has no neutral color.
  await expect(neutral).toBeDisabled();
  await dialog(page).locator('input[name=name]').fill('Dodge and burn');
  await dialog(page).locator('select[name=mode]').selectOption('overlay');
  await expect(neutral).toBeEnabled();
  await neutral.check();
  await dialog(page).locator('select[name=color]').selectOption('violet');
  await dialog(page).locator('input[name=opacity]').fill('60');
  await dialog(page).getByRole('button', { name: 'OK' }).click();
  await idle(page);
  expect(await current(page)).toMatchObject({
    name: 'Dodge and burn',
    kind: 'pixel',
    blend: 'overlay',
    opacity: 0.6,
    color: 'violet',
  });
  // Filled with 50% gray.
  const px = await layerPixel(page, 10, 10);
  expect(px[3]).toBe(255);
  expect(Math.abs(px[0] - 128)).toBeLessThanOrEqual(1);
  await expect(page.locator('#layers .layer-row.selected')).toHaveAttribute('data-color', 'violet');

  // A second layer clipped to it.
  await start(page, 'layer.new');
  await dialog(page).locator('input[type=checkbox][name=clip]').check();
  await dialog(page).getByRole('button', { name: 'OK' }).click();
  await idle(page);
  expect((await current(page)).clipped).toBe(true);
});

test('New Group from the menu asks for options; the panel button does not unless Alt is held', async ({
  page,
}) => {
  await start(page, 'layer.new-group');
  await dialog(page).locator('input[name=name]').fill('Lighting');
  await expect(dialog(page).locator('select[name=mode]')).toHaveValue('pass through');
  await dialog(page).locator('select[name=color]').selectOption('blue');
  await dialog(page).getByRole('button', { name: 'OK' }).click();
  await idle(page);
  expect(await current(page)).toMatchObject({
    name: 'Lighting',
    kind: 'group',
    blend: 'pass through',
    color: 'blue',
  });

  await page.getByRole('button', { name: 'New group', exact: true }).click();
  await idle(page);
  await expect(dialog(page)).toHaveCount(0);
  expect((await current(page)).kind).toBe('group');

  await page.getByRole('button', { name: 'New layer', exact: true }).click({ modifiers: ['Alt'] });
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).locator('h2')).toHaveText('New Layer');
  await page.keyboard.press('Escape');
});

test('Duplicate Layer names the copy and can send it to a new or another open document', async ({
  page,
}) => {
  await start(page, 'layer.duplicate-dialog');
  await dialog(page).locator('input[name=as]').fill('Sky');
  await dialog(page).getByRole('button', { name: 'OK' }).click();
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.doc.layers.map((l) => l.name))).toEqual([
    'Background',
    'Sky',
  ]);
  // One history step.
  expect(await page.evaluate(() => window.photoStudio.history.labels.at(-1))).toBe(
    'Duplicate layers',
  );

  // To a new document holding only the copy.
  await start(page, 'layer.duplicate-dialog');
  await dialog(page).locator('select[name=dest]').selectOption('new');
  await dialog(page).locator('input[name=docName]').fill('Sky only');
  await dialog(page).getByRole('button', { name: 'OK' }).click();
  await idle(page);
  const made = await page.evaluate(() => ({
    name: window.photoStudio.doc.name,
    layers: window.photoStudio.doc.layers.map((l) => l.name),
    docs: window.photoStudio.sessions.length,
  }));
  expect(made).toEqual({ name: 'Sky only', layers: ['Sky copy'], docs: 2 });
  expect((await layerPixel(page, 5, 5))[2]).toBeGreaterThan(150);

  // Back to the first document, and into the second one.
  await page.evaluate(() => (window.photoStudio.session = window.photoStudio.sessions[0]));
  await idle(page);
  await start(page, 'layer.duplicate-dialog');
  const target = await page.evaluate(() => window.photoStudio.sessions[1].id);
  await dialog(page).locator('select[name=dest]').selectOption(target);
  await expect(dialog(page).locator('input[name=docName]')).toBeDisabled();
  await dialog(page).getByRole('button', { name: 'OK' }).click();
  await idle(page);
  const into = await page.evaluate(() => ({
    name: window.photoStudio.doc.name,
    layers: window.photoStudio.doc.layers.map((l) => l.name),
    ids: new Set(window.photoStudio.doc.layers.map((l) => l.id)).size,
  }));
  expect(into).toEqual({ name: 'Sky only', layers: ['Sky copy', 'Sky copy'], ids: 2 });
  expect((await layerPixel(page, 5, 5))[2]).toBeGreaterThan(150);
});

test('Color labels from the row context menu', async ({ page }) => {
  const row = page.locator('#layers .layer-row').first();
  await row.locator('.layer-name').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Color/ }).hover();
  await page.getByRole('menuitemcheckbox', { name: 'Orange' }).click();
  await idle(page);
  await expect(row).toHaveAttribute('data-color', 'orange');
  await row.locator('.layer-name').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Color/ }).hover();
  await page.getByRole('menuitemcheckbox', { name: 'No Color' }).click();
  await idle(page);
  await expect(row).not.toHaveAttribute('data-color', /./);
});
