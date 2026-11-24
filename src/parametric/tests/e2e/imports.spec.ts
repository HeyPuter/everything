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

test('opening another part with reused import identifiers loads its own geometry', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  const { readFileSync } = await import('node:fs');
  const names = ['cube-hole-sw2022.sldprt', 'cube-shell-sw2011.sldprt'];
  const files = names.map((name) => ({ name, data: Array.from(readFileSync(new URL(`../fixtures/sldprt/${name}`, import.meta.url))) }));
  const volumes = await page.evaluate(async ({ files, url }) => {
    const { newDocument } = await import(url);
    const app = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
    const volumes: number[] = [];
    for (const file of files) {
      const { step } = await app.kernel.convertSolidWorks(new Uint8Array(file.data), file.name);
      const doc = newDocument(file.name) as import('../../src/model/types').PartDocument;
      doc.blobs.b1 = step;
      doc.features = [{ id: 'f1', name: 'Imported1', type: 'import', format: 'step', blob: 'b1', fileName: 'body.step' }];
      app.loadDocument(doc, null);
      await app.whenBuilt();
      volumes.push((await app.kernel.massProperties())!.volume);
    }
    return volumes;
  }, { files, url: '/src/model/document.ts' });
  expect(volumes[0]).toBeCloseTo(1000 - Math.PI * 2.5 * 2.5 * 10, 2);
  expect(volumes[1]).toBeCloseTo(424, 2);
  await expect(page.locator('.ti.error')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('opening a STEP file makes a new part from it instead of adding it to the open part', async ({ page }) => {
  type A = import('../../src/app/app').App;
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await expect(page.getByRole('treeitem', { name: 'Fillet1' })).toBeVisible();
  const step = await page.evaluate(async () => {
    const app = (window as unknown as { __parametric: A }).__parametric;
    await app.whenBuilt();
    const text = new TextDecoder().decode(await app.kernel.exportFile('step', 1));
    app.store.change('Edit', (d) => { d.variables.push({ id: 'v1', name: 'Width', expr: '5' }); });
    return text;
  });
  const chooser = page.waitForEvent('filechooser');
  await page.evaluate(() => (window as unknown as { __parametric: A }).__parametric.commands.run('openDevice'));
  await (await chooser).setFiles({ name: 'plate.STEP', mimeType: 'model/step', buffer: (globalThis as unknown as { Buffer: { from(s: string): never } }).Buffer.from(step) });
  // The bracket has unsaved changes: asked first, as for any other part.
  await page.getByRole('dialog', { name: 'Save changes?' }).getByRole('button', { name: "Don't save" }).click();
  await expect(page).toHaveTitle('* plate - Parametric');
  await expect(page.getByRole('treeitem', { name: 'Imported1' })).toBeVisible();
  await expect(page.getByRole('treeitem', { name: 'Fillet1' })).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __parametric: A }).__parametric.location)).toBeNull();
  expect(errors).toEqual([]);
});

test('a body imported while a sketch is open stays when the sketch changes are discarded later', async ({ page }) => {
  type A = import('../../src/app/app').App;
  const errors = await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await page.evaluate(() => (window as unknown as { __parametric: A }).__parametric.startSketchOn({ kind: 'base', plane: 'front' }));
  const chooser = page.waitForEvent('filechooser');
  await page.evaluate(() => (window as unknown as { __parametric: A }).__parametric.commands.run('importStep'));
  await (await chooser).setFiles(decodeURIComponent(new URL('../fixtures/sldprt/cube-hole-sw2022.sldprt', import.meta.url).pathname));
  await expect(page.getByRole('treeitem', { name: 'Imported1' })).toBeVisible();
  // The sketch was finished for the import, so nothing is left to discard.
  expect(await page.evaluate(() => !!(window as unknown as { __parametric: A }).__parametric.sketchEditor)).toBe(false);
  await page.evaluate(() => { void (window as unknown as { __parametric: A }).__parametric.discardSketch(); });
  await expect(page.getByRole('treeitem', { name: 'Imported1' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('Import refuses a file that is not a STEP or SolidWorks model, saying what it takes', async ({ page }) => {
  type A = import('../../src/app/app').App;
  const errors = await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await page.waitForFunction(() => (window as unknown as { __parametric?: A }).__parametric);
  const chooser = page.waitForEvent('filechooser');
  await page.evaluate(() => (window as unknown as { __parametric: A }).__parametric.commands.run('importStep'));
  const text = JSON.stringify({ format: 'parametric-part', version: 1, name: 'Other', units: 'MMGS', features: [] });
  await (await chooser).setFiles({ name: 'Other.parametric', mimeType: 'application/json', buffer: (globalThis as unknown as { Buffer: { from(s: string): never } }).Buffer.from(text) });
  await expect(page.getByRole('region', { name: 'Notifications' })).toContainText('Other.parametric is not a STEP file (.step, .stp) or a SolidWorks part (.sldprt). To work on a part file, open it with Open.');
  expect(await page.evaluate(() => (window as unknown as { __parametric: A }).__parametric.store.doc.features.length)).toBe(0);
  expect(errors).toEqual([]);
});

test('Open from device refuses a file Parametric does not open, saying which files it opens', async ({ page }) => {
  type A = import('../../src/app/app').App;
  const errors = await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await page.waitForFunction(() => (window as unknown as { __parametric?: A }).__parametric);
  const chooser = page.waitForEvent('filechooser');
  await page.evaluate(() => (window as unknown as { __parametric: A }).__parametric.commands.run('openDevice'));
  await (await chooser).setFiles({ name: 'bracket.stl', mimeType: 'model/stl', buffer: (globalThis as unknown as { Buffer: { from(s: string): never } }).Buffer.from('solid x\nendsolid x\n') });
  await expect(page.getByRole('region', { name: 'Notifications' })).toContainText('bracket.stl is not a file Parametric opens. Choose a part (.parametric), a STEP file (.step, .stp) or a SolidWorks part (.sldprt).');
  expect(errors).toEqual([]);
});
