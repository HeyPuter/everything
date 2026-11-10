import { expect, test } from '@playwright/test';
import { openApp, waitForFeature } from './helpers';

for (const format of ['step', 'stl'] as const) for (const stage of ['rebuild', 'export'] as const) test(`${format} export waiting for ${stage} is cancelled when another part opens`, async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.evaluate(async ({ format, stage }) => {
    type W = { __parametric: import('../../src/app/app').App; started: boolean; releaseExport: () => void; pendingExport: Promise<void>; downloads: string[] };
    const w = window as unknown as W, app = w.__parametric;
    await app.whenBuilt();
    const gate = new Promise<void>((r) => { w.releaseExport = r; });
    w.downloads = [];
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { if (this.download) w.downloads.push(this.download); click.call(this); };
    if (stage === 'rebuild') {
      const built = app.whenBuilt.bind(app);
      let first = true;
      app.whenBuilt = async () => { await built(); if (first) { first = false; w.started = true; await gate; } };
    } else {
      const exportFile = app.kernel.exportFile.bind(app.kernel);
      app.kernel.exportFile = async (...args) => { const data = await exportFile(...args); w.started = true; await gate; return data; };
    }
    w.pendingExport = Promise.resolve(app.commands.get(format === 'step' ? 'exportStep' : 'exportStl')!.run());
  }, { format, stage });
  await page.waitForFunction(() => (window as unknown as { started: boolean }).started);
  const downloads = await page.evaluate(async () => {
    type W = { __parametric: import('../../src/app/app').App; releaseExport: () => void; pendingExport: Promise<void>; downloads: string[] };
    const w = window as unknown as W, app = w.__parametric;
    const next = structuredClone(app.store.doc);
    next.name = 'Replacement';
    const f = next.features.find((f) => f.id === 'f1');
    if (f?.type === 'extrude') f.depth = 80;
    app.loadDocument(next, null);
    await app.whenBuilt();
    w.releaseExport();
    await w.pendingExport;
    return w.downloads;
  });
  expect(downloads).toEqual([]);
  const downloaded = page.waitForEvent('download');
  await page.evaluate((format) => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.commands.run(format === 'step' ? 'exportStep' : 'exportStl'), format);
  expect((await downloaded).suggestedFilename()).toBe(`Replacement.${format}`);
  expect(errors).toEqual([]);
});

for (const format of ['step', 'stl'] as const) test(`${format} export while editing a sketch has the whole part, not the rolled-back one`, async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  const exported = () => page.evaluate(async (format) => {
    const app = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
    const click = HTMLAnchorElement.prototype.click;
    let url = '';
    HTMLAnchorElement.prototype.click = function () { url = this.href; };
    try {
      await app.commands.get(format === 'step' ? 'exportStep' : 'exportStl')!.run();
    } finally {
      HTMLAnchorElement.prototype.click = click;
    }
    return url ? (await (await fetch(url)).arrayBuffer()).byteLength : 0;
  }, format);
  const whole = await exported();
  expect(whole).toBeGreaterThan(0);
  // Sketch2 places the holes: editing it rolls the model back to before them.
  await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.editSketch('s2'));
  await expect(page.locator('.loading-kernel')).toHaveCount(0);
  expect(await exported()).toBe(whole);
  expect(errors).toEqual([]);
});

test('export while editing a feature says to finish it instead of exporting the rolled-back part', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.evaluate(() => {
    const app = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
    app.selection.set([{ kind: 'feature', id: 'f2' }]);
    app.commands.run('editFeature');
  });
  await expect(page.locator('.pm')).toBeVisible();
  const downloads: string[] = [];
  page.on('download', (d) => downloads.push(d.suggestedFilename()));
  await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.commands.get('exportStl')!.run());
  await expect(page.getByRole('region', { name: 'Notifications' })).toContainText('before exporting');
  expect(downloads).toEqual([]);
  expect(errors).toEqual([]);
});
