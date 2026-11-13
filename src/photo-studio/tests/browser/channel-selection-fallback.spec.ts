import { expect, test } from '@playwright/test';
import { boot, idle, openImage, panel, run, start } from './helpers';

test('the default Channels selection identifies only the RGB source', async ({ page }) => {
  await boot(page);
  await openImage(page, 16, 12, '#ffffff');
  const channels = await panel(page, 'Channels');
  expect(await channels.locator('.channel-name[aria-pressed="true"]').allTextContents()).toEqual(['RGB']);
  expect(await channels.locator('.channel-row.selected').count()).toBe(1);
});

test('channel editing commands use the visible default ink source', async ({ page }) => {
  await boot(page);
  await openImage(page, 16, 12, '#008040');
  await run(page, 'image.mode-multichannel');
  const channels = await panel(page, 'Channels');
  await run(page, 'channel.duplicate');
  expect(await page.evaluate(() => window.photoStudio.doc.channels!.map((c) => c.name))).toEqual(['Cyan', 'Magenta', 'Yellow', 'Cyan copy']);
  await start(page, 'channel.options');
  const dialog = page.locator('dialog[open]');
  await expect(dialog.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Cyan');
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Ink');
  await dialog.getByRole('button', { name: 'OK', exact: true }).click();
  await idle(page);
  await run(page, 'channel.delete');
  expect(await page.evaluate(() => window.photoStudio.doc.channels!.map((c) => c.name))).toEqual(['Magenta', 'Yellow', 'Cyan copy']);
  expect(await channels.locator('.channel-name[aria-pressed="true"]').allTextContents()).toEqual(['Magenta']);
});

test('undoing the selected channel falls back to a usable RGB source', async ({ page }) => {
  await boot(page);
  await openImage(page, 16, 12, '#ffffff');
  await run(page, 'channel.new');
  const channels = await panel(page, 'Channels');
  await channels.getByRole('button', { name: 'Alpha 1', exact: true }).click();
  await run(page, 'edit.undo');
  expect(await channels.locator('.channel-name[aria-pressed="true"]').allTextContents()).toEqual(['RGB']);
  await run(page, 'edit.redo');
  expect(await channels.locator('.channel-name[aria-pressed="true"]').allTextContents()).toEqual(['Alpha 1']);
  await run(page, 'edit.undo');
  await run(page, 'select.load-active-channel');
  expect(await page.evaluate(() => window.photoStudio.doc.selection)).toMatchObject({ x: 0, y: 0, width: 16, height: 12 });
  expect(await channels.locator('.channel-name[aria-pressed="true"]').allTextContents()).toEqual(['RGB']);
});

for (const chooseBlue of [false, true]) test(`Multichannel loads its visible ink source after ${chooseBlue ? 'choosing Blue' : 'opening RGB'}`, async ({ page }) => {
  await boot(page);
  await openImage(page, 16, 12, '#008040');
  const channels = await panel(page, 'Channels');
  if (chooseBlue) await channels.getByRole('button', { name: 'Blue', exact: true }).click();
  await run(page, 'image.mode-multichannel');
  await run(page, 'select.load-active-channel');
  const result = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { readMask } = await import('/src/model/tiles.ts');
    const { selectionGrid } = await import('/src/model/selection.ts');
    const first = e.doc.channels!.find((c) => c.spot)!;
    const area = { x: 0, y: 0, width: 1, height: 1 };
    const grid = selectionGrid(e.doc, e.assets.tiles);
    return { name: first.name, expected: 255 - readMask(e.assets.tiles, first.grid, area).data[0], actual: grid ? readMask(e.assets.tiles, grid, area).data[0] : 0 };
  });
  expect(result.actual).toBe(result.expected);
  expect(await channels.locator('.channel-name[aria-pressed="true"]').allTextContents()).toEqual([result.name]);
  await run(page, 'edit.undo');
  await run(page, 'edit.undo');
  expect(await channels.locator('.channel-name[aria-pressed="true"]').allTextContents()).toEqual([chooseBlue ? 'Blue' : 'RGB']);
});
