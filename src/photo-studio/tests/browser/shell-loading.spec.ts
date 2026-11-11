// Features whose code loads on first use, when loading fails.
import { test, expect } from '@playwright/test';
import { boot } from './helpers';

test('a panel whose code could not be loaded explains it and loads again on request', async ({ page }) => {
  // Offline from the start, so an idle prefetch cannot have loaded it.
  const module = '**/src/features/assistant/panel.ts*';
  await page.route(module, (route) => route.abort());
  await boot(page);
  await page.evaluate(() => window.photoStudio.dock.show('assistant'));
  const body = page.locator('[data-panel="assistant"]');
  await expect(body.locator('.panel-load-error')).toContainText('could not be loaded');
  await expect(body).not.toHaveClass(/panel-loading/);
  await expect(page.locator('#toast')).not.toContainText('http');
  // Back online: Try Again mounts the panel.
  await page.unroute(module);
  await body.getByRole('button', { name: 'Try Again' }).click();
  await expect(body.locator('.panel-load-error')).toHaveCount(0);
  await expect(body).toHaveClass(/assistant-panel/);
});
