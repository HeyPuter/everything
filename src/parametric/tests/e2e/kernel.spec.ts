import { expect, test, type Page } from '@playwright/test';
import { openApp, waitForFeature } from './helpers';

type Kernel = {
  debugFail(mode: 'hang' | 'abort' | 'crash'): Promise<void>;
  massProperties(): Promise<{ volume: number } | null>;
  stallMs: number;
};
type W = { __parametric: { kernel: Kernel; whenBuilt(): Promise<void> }; __hung?: Promise<string> };

/** Volume computed by the (possibly restarted) worker once it has rebuilt the part. */
const volume = (page: Page) => page.evaluate(async () => {
  const app = (window as unknown as W).__parametric;
  await app.whenBuilt();
  return (await app.kernel.massProperties())?.volume ?? null;
});

test('the geometry engine is restarted and the part rebuilt when the worker dies, aborts or hangs', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  const v0 = await volume(page);
  expect(v0).toBeGreaterThan(0);
  const restarted = page.locator('.toast', { hasText: 'Geometry engine restarted' });

  for (const mode of ['crash', 'abort'] as const) {
    const msg = await page.evaluate((mode) => (window as unknown as W).__parametric.kernel.debugFail(mode).then(() => 'answered', (e: Error) => e.message), mode);
    if (mode === 'abort') expect(msg).toBe('The geometry kernel failed');
    await expect(restarted).toBeVisible();
    expect(await volume(page)).toBeCloseTo(v0!, 3);
    await restarted.getByRole('button', { name: 'Dismiss notification' }).click();
  }

  // A request that never answers: the user is offered a restart, and the
  // request rejects instead of waiting forever.
  await page.evaluate(() => {
    const w = window as unknown as W;
    w.__parametric.kernel.stallMs = 500;
    w.__hung = w.__parametric.kernel.debugFail('hang').then(() => 'answered', (e: Error) => e.message);
  });
  const stall = page.locator('.toast', { hasText: 'taking a long time' });
  await stall.getByRole('button', { name: 'Restart engine' }).click();
  expect(await page.evaluate(() => (window as unknown as W).__hung)).toMatch(/restarted because it stopped responding/);
  await expect(restarted).toBeVisible();
  expect(await volume(page)).toBeCloseTo(v0!, 3);
  await expect(page.locator('.ti.error')).toHaveCount(0);
  expect(errors).toEqual([]);
});
