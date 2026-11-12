import { test, expect } from '@playwright/test';
import { boot, idle, openImage, start } from './helpers';

test('Load Selection offers the transparency of a fill or type layer', async ({ page }) => {
  await boot(page);
  await openImage(page, 200, 150);
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { layer } = await import('/src/model/document.ts');
    // A solid fill layer covering a 60×40 rectangle.
    const l = layer('solid', 'Patch', 60, 40);
    l.color = '#3366ff';
    l.transform = { x: 30, y: 20, width: 60, height: 40, rotation: 0 };
    e.command('New Fill Layer', (d) => d.layers.push(l));
    e.selected = l.id;
  });
  await idle(page);
  await start(page, 'select.load');
  const dialog = page.locator('dialog[open]');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'Channel' })).toContainText('Patch Transparency');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await idle(page);
  const sel = await page.evaluate(() => ({ rect: window.photoStudio.doc.selection, last: window.photoStudio.history.labels.at(-1) }));
  expect(sel.last).toBe('Load Selection');
  expect(sel.rect).toMatchObject({ x: 30, y: 20, width: 60, height: 40 });
});
