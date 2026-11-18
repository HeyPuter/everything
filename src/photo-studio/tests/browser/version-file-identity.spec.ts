// An image opens as a new document (with a new ID) every time. Version
// History finds the versions kept for the same file again when it reopens.
import { test, expect, type Page } from '@playwright/test';
import { boot, idle, run, start } from './helpers';

/** Open the same file from this device (same name, size and date) through File → Open. */
const openSameFile = async (page: Page) => {
  await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(24, 16);
    const c = canvas.getContext('2d')!;
    c.fillStyle = '#3366cc';
    c.fillRect(0, 0, 24, 16);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const file = new File([blob], 'holiday.png', {
      type: 'image/png',
      lastModified: 1_700_000_000_000,
    });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.querySelector<HTMLInputElement>('#file-input')!;
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
  });
  await expect
    .poll(() => page.evaluate(() => window.photoStudio.hasDocument && window.photoStudio.doc.name))
    .toBe('holiday');
  await idle(page);
};

test('versions of an image are listed again when the same file is reopened', async ({ page }) => {
  await boot(page);
  await openSameFile(page);
  const first = await page.evaluate(() => window.photoStudio.doc.id);
  await page.evaluate(() => window.photoStudio.command('Fade', (d) => (d.layers[0].opacity = 0.5)));
  await start(page, 'file.save-version');
  const dialog = page.locator('#dialog[open]');
  await dialog.getByRole('textbox').fill('Before the trip');
  await dialog.getByRole('button', { name: 'Save Version' }).click();
  await idle(page);
  const panel = page.locator('.versions-panel');
  await expect(panel.locator('.version-row')).toHaveCount(1);
  // Close without saving and open the file again: a new document.
  await page.evaluate(() => window.photoStudio.closeSession(window.photoStudio.session, true));
  await idle(page);
  await openSameFile(page);
  expect(await page.evaluate(() => window.photoStudio.doc.id)).not.toBe(first);
  await run(page, 'file.version-history');
  await expect(panel.locator('.version-row')).toHaveCount(1);
  await expect(panel.locator('.version-row')).toContainText('Before the trip');
});
