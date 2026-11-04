import { type Page, expect } from '@playwright/test';

/** Opens the app and returns collected errors. */
export async function openApp(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/js\.puter\.com|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto('/');
  return errors;
}

export async function canvasCenter(page: Page) {
  const box = (await page.locator('canvas.gl').boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
}

/** Waits until the geometry engine has rebuilt and the tree shows a feature. */
export async function waitForFeature(page: Page, name: string) {
  await expect(page.getByRole('treeitem', { name })).toBeVisible();
  await expect(page.locator('.loading-kernel')).toHaveCount(0, { timeout: 30_000 });
}
