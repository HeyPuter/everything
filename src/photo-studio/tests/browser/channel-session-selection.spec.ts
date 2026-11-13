import { expect, test } from '@playwright/test';
import { boot, idle, openImage, panel, run } from './helpers';

for (const alpha of [false, true]) {
  test(`${alpha ? 'alpha' : 'RGB'} channel selection stays with each document tab`, async ({ page }) => {
    await boot(page);
    for (const [name, color, channel] of [['first', '#ff0000', 'Red'], ['second', '#0000ff', 'Blue']]) {
      await openImage(page, 16, 16, color, `${name}.png`);
      if (alpha) await page.evaluate(async (name) => {
        const e = window.photoStudio;
        const { emptyGrid, writeRect } = await import('/src/model/tiles.ts');
        const grid = writeRect(e.assets.tiles, emptyGrid(1), 2, 3, { width: 4, height: 5, data: new Uint8Array(20).fill(255) });
        e.command('Add channel', (d) => { d.channels = [{ id: crypto.randomUUID(), name: `${name} mask`, grid }]; });
      }, name);
      const channels = await panel(page, 'Channels');
      await channels.getByRole('button', { name: alpha ? `${name} mask` : channel, exact: true }).click();
      await idle(page);
    }
    for (const [name, channel] of [['first', 'Red'], ['second', 'Blue']]) {
      await page.evaluate(async (name) => {
        const e = window.photoStudio;
        await e.switchSession(e.sessions.find((s) => s.doc.name === name)!);
      }, name);
      await run(page, 'select.load-active-channel');
      expect(await page.evaluate(() => window.photoStudio.doc.selection)).toMatchObject(alpha ? { x: 2, y: 3, width: 4, height: 5 } : { x: 0, y: 0, width: 16, height: 16 });
      const channels = await panel(page, 'Channels');
      await expect(channels.getByRole('button', { name: alpha ? `${name} mask` : channel, exact: true })).toHaveAttribute('aria-pressed', 'true');
    }
  });
}
