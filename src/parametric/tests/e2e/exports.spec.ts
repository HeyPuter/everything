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
