// Duplicate Layer used to refuse anything past 200 layers ("A document can
// contain up to 200 layers.") although documents hold up to MAX_LAYERS (8000)
// everywhere else: New Layer, Paste, grouping and opening files.
import { expect, test } from '@playwright/test';
import { layer, newDocument } from '../../src/model/document';
import { boot, idle, openProject, run } from './helpers';

test('Duplicate Layer works past 200 layers and stops at the document limit', async ({ page }) => {
  await boot(page);
  const doc = newDocument(64, 64, 'Many layers');
  doc.layers = Array.from({ length: 150 }, (_, i) => layer('solid', `Layer ${i + 1}`, 16, 16));
  await openProject(page, doc, [], 'many.photo');
  await page.evaluate(() => {
    const e = window.photoStudio;
    e.selectLayers(e.doc.layers.map((l) => l.id));
  });
  await run(page, 'layer.duplicate');
  expect(await page.evaluate(() => window.photoStudio.doc.layers.length)).toBe(300);

  // At the limit the copy is refused with a message and nothing changes.
  const refused = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { MAX_LAYERS, layer } = await import('/src/model/document.ts');
    e.command('Fill', (d) => {
      while (d.layers.length < MAX_LAYERS) d.layers.push(layer('solid', 'Filler', 16, 16));
    });
    e.selectLayers([e.doc.layers[0].id]);
    const before = e.history.labels.length;
    let error = '';
    const { performAction } = await import('/src/ui/actions.ts');
    await performAction(e, 'duplicate').catch((err) => (error = String(err)));
    return { error, layers: e.doc.layers.length, max: MAX_LAYERS, added: e.history.labels.length - before };
  });
  await idle(page);
  expect(refused.error).toContain(`up to ${refused.max} layers`);
  expect(refused.layers).toBe(refused.max);
  expect(refused.added).toBe(0);
});
