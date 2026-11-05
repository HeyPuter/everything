import { expect, test } from '@playwright/test';
import { openApp } from './helpers';

for (const nextId of [Number.MAX_SAFE_INTEGER, 1e100]) test(`part counter ${nextId} keeps new sketches independently editable`, async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  const sketches = await page.evaluate(async ({ nextId, url }) => {
    const { parseDocument } = await import(url);
    const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
    a.loadDocument(parseDocument(JSON.stringify({ ...a.store.doc, nextId })), null);
    for (let i = 1; i <= 3; i++) {
      a.startSketchOn({ kind: 'base', plane: 'front' });
      a.sketchEditor!.edit('Point', (sk) => { sk.entities.push({ id: 'p1', t: 'point', x: i * 10, y: 0 }); });
      a.exitSketch(true);
    }
    await a.whenBuilt();
    return a.store.doc.features.map((f) => ({ id: f.id, points: f.type === 'sketch' ? f.entities.filter((e) => e.t === 'point').map((e) => e.x) : [] }));
  }, { nextId, url: '/src/model/document.ts' });
  expect(new Set(sketches.map((s) => s.id)).size).toBe(3);
  expect(sketches.map((s) => s.points)).toEqual([[10], [20], [30]]);
  expect(errors).toEqual([]);
});

for (const ids of [['s1', 's1'], ['']]) test(`invalid feature identifiers ${JSON.stringify(ids)} are rejected before discarding work`, async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await page.evaluate(() => {
    const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
    a.store.change('Unsaved work', (d) => { d.variables.push({ id: 'v1', name: 'Keep', expr: '42' }); });
  });
  const text = JSON.stringify({ format: 'parametric-part', version: 1, name: 'Incoming', features: ids.map((id) => ({
    id, name: 'Sketch', type: 'sketch', plane: { kind: 'base', plane: 'front' }, entities: [], constraints: [],
  })) });
  const chooser = page.waitForEvent('filechooser');
  await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.commands.run('openDevice'));
  const buffer = (globalThis as unknown as { Buffer: { from(value: string): never } }).Buffer.from(text);
  await (await chooser).setFiles({ name: 'damaged.parametric', mimeType: 'application/json', buffer });
  await expect(page.getByRole('alert').filter({ hasText: 'invalid feature identifiers' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Save changes?' })).toHaveCount(0);
  await expect(page).toHaveTitle('* Part1 - Parametric');
  expect(await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.store.doc.variables[0].name)).toBe('Keep');
  expect(errors).toEqual([]);
});
