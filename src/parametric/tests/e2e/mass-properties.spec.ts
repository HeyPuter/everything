import { expect, test } from '@playwright/test';
import { openApp, waitForFeature } from './helpers';

test('mass properties opened right after a change describe the rebuilt part', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.evaluate(() => (window as unknown as { __parametric: { whenBuilt(): Promise<void> } }).__parametric.whenBuilt());
  // Double the extrusion depth and open the dialog before the rebuild has finished.
  await page.evaluate(() => {
    const app = (window as unknown as { __parametric: { store: { change(l: string, fn: (d: { features: { id: string; depth?: number }[] }) => void): void }; commands: { run(id: string): void } } }).__parametric;
    app.store.change('Depth', (d) => { d.features.find((f) => f.id === 'f1')!.depth = 60; });
    app.commands.run('massProperties');
  });
  const dialog = page.getByRole('dialog', { name: 'Mass Properties' });
  await expect(dialog).toContainText('43513.08');
});

for (const change of ['edit', 'new document'] as const) test(`mass properties finishing after ${change} do not show the old body's results`, async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.evaluate(async () => {
    type W = { __parametric: import('../../src/app/app').App; massStarted: boolean; releaseMass: () => void; massDone: boolean };
    const w = window as unknown as W, app = w.__parametric;
    await app.whenBuilt();
    const mass = app.kernel.massProperties.bind(app.kernel);
    const gate = new Promise<void>((r) => { w.releaseMass = r; });
    app.kernel.massProperties = async () => { const result = await mass(); w.massStarted = true; await gate; return result; };
    w.massDone = false;
    void Promise.resolve(app.commands.get('massProperties')!.run()).then(() => { w.massDone = true; });
  });
  await page.waitForFunction(() => (window as unknown as { massStarted: boolean }).massStarted);
  await page.evaluate(async (change) => {
    type W = { __parametric: import('../../src/app/app').App; releaseMass: () => void };
    const w = window as unknown as W, app = w.__parametric;
    if (change === 'new document') app.newDocument('New part');
    else app.store.change('Depth', (d) => {
      const f = d.features.find((f) => f.id === 'f1');
      if (f?.type === 'extrude') f.depth = 60;
    });
    await app.whenBuilt();
    w.releaseMass();
  }, change);
  const dialog = page.getByRole('dialog', { name: 'Mass Properties' });
  if (change === 'new document') {
    await expect.poll(() => page.evaluate(() => (window as unknown as { massDone: boolean }).massDone)).toBe(true);
    await expect(dialog).toHaveCount(0);
  } else {
    await expect(dialog).toContainText('43513.08');
    await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  }
  expect(errors).toEqual([]);
});
