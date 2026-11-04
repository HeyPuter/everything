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
