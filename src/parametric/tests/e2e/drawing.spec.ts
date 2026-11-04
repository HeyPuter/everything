import { expect, test } from '@playwright/test';
import { openApp, waitForFeature } from './helpers';

test('makes a drawing with standard views and exports a PDF', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.getByRole('tab', { name: 'Drawing' }).click();
  const paper = page.getByRole('img', { name: 'Drawing sheet' });
  await expect(paper).toBeVisible();
  // Front, top, right and isometric views are projected by the geometry engine.
  await expect(page.locator('.relations-list > *')).toHaveCount(4, { timeout: 30_000 });
  await expect(paper.locator('svg path').first()).toBeAttached({ timeout: 30_000 });
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'PDF', exact: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('Mounting Bracket.pdf');
  expect(await file.failure()).toBeNull();
  await page.getByRole('tab', { name: 'Model' }).click();
  await expect(page.locator('canvas.gl')).toBeVisible();
  expect(errors).toEqual([]);
});

test('a view added while the others are still being projected is drawn too', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  const pending = await page.evaluate(async () => {
    type Ws = { pending: boolean; addView(kind: string): void };
    const app = (window as unknown as { __parametric: { openDrawing(): void; drawing: Ws } }).__parametric;
    app.openDrawing();
    const t0 = performance.now();
    while (!app.drawing.pending && performance.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 1));
    app.drawing.addView('back');
    return app.drawing.pending;
  });
  expect(pending).toBe(true);
  await expect(page.locator('.paper g[data-view]')).toHaveCount(5);
  await expect(page.locator('.paper g[data-view="v5"] path').first()).toBeAttached();
});
