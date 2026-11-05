import { expect, test } from '@playwright/test';
import { openApp } from './helpers';

test('imports keep separate file data when their timestamps are identical', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await page.evaluate(() => {
    const now = Date.now();
    Date.now = () => now;
  });
  let original: { blob: string; text: string; volume: number } | undefined;
  const names = ['cube-hole-sw2022.sldprt', 'cube-shell-sw2011.sldprt'];
  for (const [i, name] of names.entries()) {
    const chooser = page.waitForEvent('filechooser');
    await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.commands.run('importStep'));
    await (await chooser).setFiles(decodeURIComponent(new URL(`../fixtures/sldprt/${name}`, import.meta.url).pathname));
    await expect(page.getByRole('treeitem', { name: `Imported${i + 1}` })).toBeVisible();
    const current = await page.evaluate(async () => {
      const app = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
      await app.whenBuilt();
      const f = app.store.doc.features[0];
      if (f.type !== 'import') throw new Error('Missing import');
      return { blob: f.blob, text: app.store.doc.blobs[f.blob], volume: (await app.kernel.massProperties())!.volume };
    });
    if (!original) original = current;
    else expect(current.text === original.text).toBe(true);
  }
  const saved = await page.evaluate(async (url) => {
    const { serializeDocument } = await import(url);
    const app = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
    const doc = JSON.parse(serializeDocument(app.store.doc)) as import('../../src/model/types').PartDocument;
    return { blobs: Object.keys(doc.blobs), refs: doc.features.flatMap((f) => f.type === 'import' ? [f.blob] : []) };
  }, '/src/model/document.ts');
  expect(new Set(saved.refs).size).toBe(2);
  expect(saved.blobs.sort()).toEqual(saved.refs.sort());
  const undone = await page.evaluate(async () => {
    const app = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
    app.store.undo();
    await app.whenBuilt();
    return (await app.kernel.massProperties())!.volume;
  });
  expect(undone).toBeCloseTo(original!.volume, 5);
  await expect(page.locator('.ti.error')).toHaveCount(0);
  expect(errors).toEqual([]);
});
