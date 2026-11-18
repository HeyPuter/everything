import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { boot, canvasDrag, idle, openImage, run, start, tool, undo } from './helpers';

/** Names of the entries in a STORE-only ZIP (local headers in order). */
function zipNames(buf: Buffer) {
  const names: string[] = [];
  let p = 0;
  while (buf.readUInt32LE(p) === 0x04034b50) {
    const size = buf.readUInt32LE(p + 18),
      nameLength = buf.readUInt16LE(p + 26),
      extra = buf.readUInt16LE(p + 28);
    names.push(buf.subarray(p + 30, p + 30 + nameLength).toString('utf8'));
    p += 30 + nameLength + extra + size;
  }
  return names;
}

test('draw, select, move and export slices', async ({ page }) => {
  await boot(page);
  await openImage(page, 400, 300, '#3a7bd5', 'slices.png');
  await tool(page, 'Slice Tool');
  await canvasDrag(page, [[100, 80], [200, 150], [250, 180]]);
  const slices = await page.evaluate(() => window.photoStudio.doc.slices);
  expect(slices).toHaveLength(1);
  expect(slices![0].rect).toEqual({ x: 100, y: 80, width: 150, height: 100 });
  // One user slice plus four automatic slices around it, numbered in reading order.
  await expect(page.locator('#overlay .slice-badge')).toHaveCount(5);
  await expect(page.locator('#overlay .slice-badge.user text')).toHaveText('03');
  expect(await page.evaluate(() => window.photoStudio.preferences.showSlices)).toBe(true);

  await tool(page, 'Slice Select Tool');
  await canvasDrag(page, [[150, 120], [170, 130], [190, 140]]);
  expect(await page.evaluate(() => window.photoStudio.doc.slices![0].rect)).toEqual({ x: 140, y: 100, width: 150, height: 100 });
  expect(await page.evaluate(() => window.photoStudio.history.labels.at(-1))).toBe('Move Slice');
  await undo(page);
  expect(await page.evaluate(() => window.photoStudio.doc.slices![0].rect)).toEqual({ x: 100, y: 80, width: 150, height: 100 });

  // Hiding slices removes the overlay outside the slice tools.
  await tool(page, 'Move Tool');
  await run(page, 'view.show-slices');
  await expect(page.locator('#overlay .slice-badge')).toHaveCount(0);
  await run(page, 'view.show-slices');
  await expect(page.locator('#overlay .slice-badge')).toHaveCount(5);

  await start(page, 'file.export-web');
  const dialog = page.locator('dialog.web-export-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('tab', { name: '4-Up' }).click();
  await expect(dialog.locator('.web-pane')).toHaveCount(4);
  await expect(dialog.locator('.web-pane.optimized figcaption span').first()).toContainText(/(B|KB) · .* at 8 Mbps/, { timeout: 60_000 });
  await expect(dialog.locator('.web-pane.optimized figcaption span')).toHaveText(Array(3).fill(/at 8 Mbps/), { timeout: 60_000 });
  // Select the user slice in the current pane and make it a JPEG.
  await dialog.locator('.web-pane.optimized').first().locator('rect.user').click();
  await expect(dialog.locator('.web-scope')).toContainText('03');
  await dialog.locator('select[name=format]').selectOption('jpeg');
  await expect(dialog.locator('.web-pane.active figcaption strong')).toHaveText(/JPEG 80/, { timeout: 30_000 });
  await expect(dialog.locator('.web-total')).toContainText('5 files', { timeout: 60_000 });
  const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Export…' }).click()]);
  const names = zipNames(await readFile((await download.path())!));
  expect(names.filter((n) => n.startsWith('images/'))).toHaveLength(5);
  expect(names.filter((n) => n.endsWith('.jpg'))).toHaveLength(1);
  expect(names.some((n) => n.endsWith('.html'))).toBe(true);
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.doc.slices![0].format)).toBe('jpeg');

  // Layer-based slices follow their layer; Clear Slices removes everything.
  await run(page, 'layer.new-layer-slice');
  expect(await page.evaluate(() => window.photoStudio.doc.slices!.filter((s) => s.layerId).length)).toBe(1);
  await run(page, 'view.clear-slices');
  expect(await page.evaluate(() => window.photoStudio.doc.slices)).toBeUndefined();
});

test('promote, divide, name and lock slices', async ({ page }) => {
  await boot(page);
  await openImage(page, 300, 200, '#808080', 'promote.png');
  await page.evaluate(() => window.photoStudio.command('Guides', (d) => (d.guides = [{ orientation: 'vertical', position: 150 }])));
  await run(page, 'slices.from-guides');
  expect(await page.evaluate(() => window.photoStudio.doc.slices!.map((s) => s.rect.width))).toEqual([150, 150]);
  await tool(page, 'Slice Select Tool');
  // Divide the left slice into two rows.
  await canvasDrag(page, [[50, 50], [50, 50]]);
  await start(page, 'slices.divide');
  const divide = page.locator('dialog[open]');
  await divide.locator('input[name=cols]').fill('1');
  await divide.locator('input[name=rows]').fill('2');
  await divide.getByRole('button', { name: 'Divide' }).click();
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.doc.slices!.length)).toBe(3);
  // Name the top-left part through Slice Options (double-click).
  await page.evaluate(() => window.photoStudio.command('One', (d) => (d.slices = d.slices!.slice(0, 1))));
  const [cx, cy] = await page.evaluate(() => window.photoStudio.clientPoint(50, 50));
  await page.mouse.dblclick(cx, cy);
  const options = page.locator('dialog.slice-options-dialog');
  await expect(options).toBeVisible();
  await options.locator('input[name=name]').fill('logo');
  await options.locator('select[name=format]').selectOption('webp');
  await options.getByRole('button', { name: 'OK' }).click();
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.doc.slices![0])).toMatchObject({ name: 'logo', format: 'webp', quality: 80 });
  // Click an automatic slice and promote it.
  await canvasDrag(page, [[250, 150], [250, 150]]);
  await expect(page.locator('#tool-options [data-command="slices.promote"]')).toBeEnabled();
  await run(page, 'slices.promote');
  expect(await page.evaluate(() => window.photoStudio.doc.slices!.length)).toBe(2);
  // Locked slices cannot be deleted.
  await run(page, 'view.lock-slices');
  await page.keyboard.press('Delete');
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.doc.slices!.length)).toBe(2);
  await run(page, 'view.lock-slices');
  await page.locator('#viewport').focus();
  await page.keyboard.press('Delete');
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.doc.slices!.length)).toBe(1);
});

test('Divide Slice keeps names and slice counts that the project can reopen with', async ({ page }) => {
  await boot(page);
  await openImage(page, 300, 200, '#808080', 'divide.png');
  await page.evaluate(() =>
    window.photoStudio.command('Slice', (d) => {
      d.slices = [{ id: crypto.randomUUID(), name: 'n'.repeat(256), rect: { x: 0, y: 0, width: 300, height: 200 } }];
    }),
  );
  await tool(page, 'Slice Select Tool');
  await canvasDrag(page, [[50, 50], [50, 50]]);
  const divide = async (cols: string, rows: string) => {
    await start(page, 'slices.divide');
    const dialog = page.locator('dialog[open]');
    await dialog.locator('input[name=cols]').fill(cols);
    await dialog.locator('input[name=rows]').fill(rows);
    await dialog.getByRole('button', { name: 'Divide' }).click();
    await idle(page);
  };
  // 64 × 64 parts would be over the slice limit: nothing changes.
  await divide('64', '64');
  await expect(page.locator('#status')).toContainText('2000');
  expect(await page.evaluate(() => window.photoStudio.doc.slices!.length)).toBe(1);
  await divide('3', '1');
  const names = await page.evaluate(() => window.photoStudio.doc.slices!.map((s) => s.name!));
  expect(names.map((n) => n.length)).toEqual([256, 256, 256]);
  expect(names[2].endsWith('_3')).toBe(true);
  const valid = await page.evaluate(async () => {
    const { validateSlices } = await import('/src/model/slices.ts');
    validateSlices(window.photoStudio.doc.slices);
    return true;
  });
  expect(valid).toBe(true);
});
