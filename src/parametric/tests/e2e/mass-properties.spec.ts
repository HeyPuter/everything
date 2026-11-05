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

for (const density of [-1000, 0]) test(`loaded density ${density} does not produce nonpositive mass`, async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await page.evaluate(async ({ density, url }) => {
    const { parseDocument } = await import(url);
    const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
    a.loadDocument(parseDocument(JSON.stringify({ ...a.store.doc, material: { name: 'Damaged material', density } })), null);
    await a.whenBuilt();
    a.commands.run('massProperties');
  }, { density, url: '/src/model/document.ts' });
  const dialog = page.getByRole('dialog', { name: 'Mass Properties', exact: true });
  const mass = dialog.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'Mass', exact: true }) }).getByRole('cell');
  await expect(mass).toBeVisible();
  expect(Number.parseFloat((await mass.innerText()).replace('−', '-'))).toBeGreaterThan(0);
  await expect(dialog).toContainText('Not specified (using 1000 kg/m³)');
  expect(errors).toEqual([]);
});

for (const change of ['edit', 'new document'] as const) test(`a displayed mass report closes after ${change} invalidates its results`, async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await page.evaluate(async () => {
    const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
    await a.whenBuilt();
    a.commands.run('massProperties');
  });
  const dialog = page.getByRole('dialog', { name: 'Mass Properties', exact: true });
  await expect(dialog).toBeVisible();
  await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.store.emit('saved'));
  await expect(dialog).toBeVisible();
  await page.evaluate((change) => {
    const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
    if (change === 'new document') a.newDocument('Replacement');
    else a.store.change('Change depth', (d) => { const f = d.features.find((f) => f.type === 'extrude')!; if (f.type === 'extrude') f.depth = 60; });
  }, change);
  await expect(dialog).toHaveCount(0);
  if (change === 'edit') {
    await page.evaluate(async () => {
      const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
      await a.whenBuilt();
      a.commands.run('massProperties');
    });
    await expect(dialog).toContainText('43513.08');
    await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  }
  expect(errors).toEqual([]);
});

for (const failure of ['denied', 'unavailable'] as const) test(`mass report Copy explains ${failure} clipboard access and supports retry`, async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await page.evaluate(async (failure) => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: failure === 'unavailable' ? undefined : {
      writeText: async () => { throw new DOMException('Clipboard write denied', 'NotAllowedError'); },
    } });
    const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
    await a.whenBuilt();
    a.commands.run('massProperties');
  }, failure);
  const dialog = page.getByRole('dialog', { name: 'Mass Properties', exact: true });
  const copy = dialog.getByRole('button', { name: 'Copy', exact: true });
  await copy.click();
  await expect(dialog.getByRole('alert')).toContainText('Could not copy');
  await expect(dialog.getByRole('alert')).toContainText('select and copy');
  await expect(page.locator('.toast', { hasText: 'Copied to the clipboard' })).toHaveCount(0);
  await expect(copy).toBeEnabled();
  expect(errors).toEqual([]);
  await page.evaluate(() => {
    const w = window as unknown as { copiedReport: string; releaseCopy: () => void };
    const gate = new Promise<void>((resolve) => { w.releaseCopy = resolve; });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text: string) => { await gate; w.copiedReport = text; },
    } });
  });
  await copy.click();
  await expect(copy).toBeDisabled();
  await expect(dialog.getByRole('alert')).toBeHidden();
  await expect(page.locator('.toast', { hasText: 'Copied to the clipboard' })).toHaveCount(0);
  await page.evaluate(() => (window as unknown as { releaseCopy: () => void }).releaseCopy());
  await expect(page.locator('.toast', { hasText: 'Copied to the clipboard' })).toBeVisible();
  await expect(copy).toBeEnabled();
  const text = await page.evaluate(() => (window as unknown as { copiedReport: string }).copiedReport);
  expect(text).toContain('Mass properties of Mounting Bracket');
  for (const label of ['Material:', 'Mass:', 'Volume:', 'Surface area:', 'Center of mass:', 'Ixx', 'Iyy', 'Izz', 'Principal moments:']) expect(text).toContain(label);
  expect(errors).toEqual([]);
});
