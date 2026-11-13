import { expect, test } from '@playwright/test';
import { boot, openImage } from './helpers';

test('New Layer refuses an over-limit insertion without changing history or selection', async ({ page }) => {
  await boot(page);
  await openImage(page, 8, 8);
  const result = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { MAX_LAYERS, layer } = await import('/src/model/document.ts');
    const original = e.doc, update = e.update;
    // Test the real command and history normalization without rendering an
    // 8,000-row panel or allocating 8,000 image surfaces on the test machine.
    e.update = () => {};
    try {
      const doc = structuredClone(original);
      doc.layers = Array.from({ length: MAX_LAYERS }, () => layer('solid', 'Filler', 1, 1));
      e.history.reset(doc);
      e.selected = doc.layers[0].id;
      const selected = e.selected;
      await e.runCommand('layer.new-quick');
      return { count: e.doc.layers.length, max: MAX_LAYERS, undo: e.history.canUndo, same: e.doc === doc, selected: e.selected === selected, message: document.querySelector('#status')!.textContent };
    } finally {
      e.history.reset(original);
      e.selected = original.layers[0].id;
      e.update = update;
      e.update();
    }
  });
  expect(result.count).toBe(result.max);
  expect(result).toMatchObject({ undo: false, same: true, selected: true });
  expect(result.message).toContain(`up to ${result.max} layers`);
});

test('capacity checks count nested layers and preserve edits to older over-limit projects', async ({ page }) => {
  await boot(page);
  await openImage(page, 8, 8);
  const result = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { MAX_LAYERS, allLayers, layer } = await import('/src/model/document.ts');
    const original = e.doc, update = e.update;
    e.update = () => {};
    try {
      const doc = structuredClone(original);
      const group = layer('group', 'Group', 1, 1);
      group.children = Array.from({ length: MAX_LAYERS }, () => layer('solid', 'Filler', 1, 1));
      doc.layers = [group]; // An older project with 8,001 total layers.
      e.history.reset(doc);
      e.command('Opacity', (d) => { d.layers[0].children[0].opacity = 0.5; });
      const opacity = e.doc.layers[0].children[0].opacity;
      e.command('Replace', (d) => { d.layers[0].children.splice(0, 1, layer('solid', 'Replacement', 1, 1)); });
      const replaced = e.doc.layers[0].children[0].name;
      const before = e.doc, labels = e.history.labels;
      let error = '';
      try { e.command('Insert', (d) => { d.layers[0].children.push(layer('solid', 'Extra', 1, 1)); }); }
      catch (err) { error = String(err); }
      const rejected = e.doc === before && JSON.stringify(e.history.labels) === JSON.stringify(labels);
      e.command('Delete', (d) => { d.layers[0].children.splice(0, 2); });
      e.command('Insert below limit', (d) => { d.layers[0].children.push(layer('solid', 'Allowed', 1, 1)); });
      return { opacity, replaced, rejected, error, count: allLayers(e.doc.layers).length, max: MAX_LAYERS };
    } finally {
      e.history.reset(original);
      e.selected = original.layers[0].id;
      e.update = update;
      e.update();
    }
  });
  expect(result).toMatchObject({ opacity: 0.5, replaced: 'Replacement', rejected: true });
  expect(result.error).toContain(`up to ${result.max} layers`);
  expect(result.count).toBe(result.max);
});
