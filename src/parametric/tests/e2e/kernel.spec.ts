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

test('an imported body is rebuilt after the geometry engine restarts', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  const v0 = await volume(page);
  // Import the bracket's own STEP into a new part.
  await page.evaluate(async () => {
    type A = W['__parametric'] & { kernel: { exportFile(f: 'step'): Promise<Uint8Array> }; newDocument(n: string): void; insertFeature(f: unknown): void; store: { doc: { blobs: Record<string, string> } } };
    const app = (window as unknown as { __parametric: A }).__parametric;
    const step = new TextDecoder().decode(await app.kernel.exportFile('step'));
    app.newDocument('Imported');
    app.store.doc.blobs.bx = step;
    app.insertFeature({ id: 'f9', name: 'Import1', type: 'import', format: 'step', blob: 'bx', fileName: 'bracket.step' });
  });
  await waitForFeature(page, 'Import1');
  expect(await volume(page)).toBeCloseTo(v0!, 1);
  await page.evaluate(() => (window as unknown as W).__parametric.kernel.debugFail('crash').catch(() => undefined));
  await expect(page.locator('.toast', { hasText: 'Geometry engine restarted' })).toBeVisible();
  // The new worker was given the file data again.
  expect(await volume(page)).toBeCloseTo(v0!, 1);
  await expect(page.locator('.ti.error')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a rebuild that leaves the body unchanged does not resend or re-upload its mesh', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  type A = W['__parametric'] & {
    renderer: { setModel(...a: unknown[]): void; modelMesh: unknown };
    store: { change(label: string, fn: (d: { features: { name: string; type: string; radius?: number }[] }) => void): void };
  };
  const uploads = () => page.evaluate(async () => {
    const app = (window as unknown as { __parametric: A }).__parametric;
    await app.whenBuilt();
    return (window as unknown as { __uploads: number }).__uploads;
  });
  await page.evaluate(async () => {
    const app = (window as unknown as { __parametric: A }).__parametric;
    await app.whenBuilt();
    const w = window as unknown as { __uploads: number };
    w.__uploads = 0;
    const set = app.renderer.setModel.bind(app.renderer);
    app.renderer.setModel = (...a: unknown[]) => { w.__uploads++; set(...a); };
    app.store.change('Rename', (d) => { d.features.find((f) => f.type === 'fillet')!.name = 'Round'; });
  });
  await expect(page.getByRole('treeitem', { name: 'Round' })).toBeVisible();
  expect(await uploads()).toBe(0);
  expect(await page.evaluate(() => !!(window as unknown as { __parametric: A }).__parametric.renderer.modelMesh)).toBe(true);
  // A change to the body still updates it.
  await page.evaluate(() => (window as unknown as { __parametric: A }).__parametric.store.change('Radius', (d) => { d.features.find((f) => f.type === 'fillet')!.radius = 2; }));
  expect(await uploads()).toBe(1);
  expect(errors).toEqual([]);
});
