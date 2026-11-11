// A cleared number field in the warp option bars keeps the value in use: Pin
// Warp's Expansion and Context Scale's Amount used to read a blank entry as 0.
import { test, expect, type Page } from '@playwright/test';
import { boot, idle, openImage, run } from './helpers';

const settings = (page: Page) => page.evaluate(() => ({ ...(window.photoStudio.modal as unknown as { s: Record<string, unknown> }).s }));
async function clear(page: Page, id: string) {
  const field = page.locator(`#tool-options #${id}`);
  await field.fill('');
  await field.press('Enter');
  await field.blur();
}

test('clearing Pin Warp Expansion or Context Scale Amount keeps the value in use', async ({ page }) => {
  await boot(page);
  await openImage(page, 200, 150, '#808080');
  await run(page, 'edit.pin-warp');
  const expansion = (await settings(page)).expansion;
  expect(expansion).toBeGreaterThan(0);
  await clear(page, 'pw-expansion');
  await idle(page);
  expect((await settings(page)).expansion).toBe(expansion);
  await expect(page.locator('#tool-options #pw-expansion')).toHaveValue(String(expansion));
  await page.keyboard.press('Escape');
  await idle(page);

  await run(page, 'edit.context-scale');
  const amount = (await settings(page)).amount;
  expect(amount).toBeGreaterThan(0);
  await clear(page, 'cs-amount');
  await idle(page);
  expect((await settings(page)).amount).toBe(amount);
  await expect(page.locator('#tool-options #cs-amount')).toHaveValue(String(amount));
});
