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
