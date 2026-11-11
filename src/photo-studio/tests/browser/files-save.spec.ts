// Saving and downloading projects from an embedded object's contents tab.
import { test, expect } from '@playwright/test';
import { boot, idle, openImage, run } from './helpers';

test('downloading a contents tab keeps its changes unsaved until they reach the parent', async ({ page }) => {
  await boot(page);
  await openImage(page, 160, 120, '#f0f0f0', 'card.png');
  // Place a red square as an embedded object and edit its contents.
  await page.evaluate(async () => {
    const c = new OffscreenCanvas(40, 40);
    const g = c.getContext('2d')!;
    g.fillStyle = '#f00';
    g.fillRect(0, 0, 40, 40);
    const { openFile } = await import('/src/features/files/open.ts');
    await openFile(window.photoStudio, await c.convertToBlob({ type: 'image/png' }), 'square.png', true);
  });
  await idle(page);
  await run(page, 'layer.embed-edit');
  await expect.poll(() => page.evaluate(() => window.photoStudio.sessions.length)).toBe(2);
  await page.evaluate(() => window.photoStudio.command('Hide', (d) => (d.layers[0].opacity = 0.5)));
  await idle(page);
  const download = page.waitForEvent('download');
  await run(page, 'file.download-project');
  expect((await download).suggestedFilename()).toMatch(/\.photo$/);
  // The parent was not updated, so the tab still has unsaved changes.
  expect(await page.evaluate(() => window.photoStudio.session.dirty)).toBe(true);
  void page.evaluate(() => window.photoStudio.runCommand('file.close'));
  const dialog = page.locator('#dialog[open]');
  await expect(dialog).toContainText('Save changes');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => [window.photoStudio.sessions.length, window.photoStudio.session.dirty])).toEqual([2, true]);
});
