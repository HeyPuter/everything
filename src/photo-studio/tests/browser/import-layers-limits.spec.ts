// Import Layers wraps a file's layers in a group, inside the selected layer's
// group. Deeply nested files used to import into a document that saved but
// could not be reopened ("Too many nested groups."); such imports now go to
// the top level, or are refused when even that is too deep.
import { expect, test } from '@playwright/test';
import { boot, idle, openImage } from './helpers';

test('imported groups stay within the nesting a project can reopen', async ({ page }) => {
  await boot(page);
  await openImage(page, 64, 64, '#ffffff');
  const result = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { layer, newDocument } = await import('/src/model/document.ts');
    const { Assets } = await import('/src/model/assets.ts');
    const { serialize, deserialize } = await import('/src/model/serialization.ts');
    const { importLayersFrom } = await import('/src/features/files/import-layers.ts');
    // A file whose deepest layer sits in `levels` nested groups (11 is the most a project holds).
    const nested = (levels: number) => {
      const doc = newDocument(64, 64, 'Deep');
      let inner = layer('solid', 'Leaf', 64, 64);
      for (let i = 0; i < levels; i++) {
        const g = layer('group', `Group ${levels - i}`, 64, 64);
        g.children = [inner];
        inner = g;
      }
      doc.layers = [inner];
      return doc;
    };
    const reopens = async () => {
      try {
        await deserialize(await serialize(e.doc, e.assets));
        return 'ok';
      } catch (error) {
        return String(error);
      }
    };
    const depth = (layers: typeof e.doc.layers, d = 0): number => Math.max(d, ...layers.map((l) => depth(l.children, d + 1)));
    // Into a group: the imported group goes to the top level instead.
    e.command('Group', (d) => {
      const g = layer('group', 'Outer', 64, 64);
      g.children = [layer('solid', 'Inner', 64, 64)];
      d.layers.push(g);
    });
    e.selected = e.doc.layers[1].children[0].id;
    await importLayersFrom(e, await serialize(nested(10), new Assets()), 'Deep.photo');
    const first = { layers: e.doc.layers.length, depth: depth(e.doc.layers), reopens: await reopens() };
    // A file that is already as deep as a project can be cannot be wrapped.
    const before = e.history.labels.length;
    await importLayersFrom(e, await serialize(nested(11), new Assets()), 'Deeper.photo');
    return { first, added: e.history.labels.length - before, reopens: await reopens() };
  });
  await idle(page);
  expect(result.first).toEqual({ layers: 3, depth: 12, reopens: 'ok' });
  expect(result.added).toBe(0);
  expect(result.reopens).toBe('ok');
});
