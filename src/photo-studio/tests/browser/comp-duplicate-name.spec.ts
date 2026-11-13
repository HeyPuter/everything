import { expect, test } from '@playwright/test';
import { layer, newDocument } from '../../src/model/document';
import { newLayerComp } from '../../src/model/layer-comps';
import { boot, openProject, run } from './helpers';

for (const name of ['Layout', 'A'.repeat(256), '😀'.repeat(128)]) {
  test(`duplicating a comp with a ${name.length}-unit ${name.startsWith('😀') ? 'Unicode' : 'text'} name keeps the project reopenable`, async ({ page }) => {
    await boot(page);
    const doc = newDocument(16, 16, 'Comps');
    doc.layers = [layer('solid', 'Square', 16, 16)];
    const comp = newLayerComp(doc, name, { visibility: true, position: true, appearance: true });
    doc.layerComps = [comp];
    doc.lastComp = comp.id;
    await openProject(page, doc);
    await run(page, 'comps.duplicate');
    const names = await page.evaluate(async () => {
      const e = window.photoStudio;
      const { serialize, deserialize } = await import('/src/model/serialization.ts');
      const loaded = await deserialize(await serialize(e.doc, e.assets));
      return loaded.document.layerComps!.map((c) => c.name);
    });
    expect(names).toHaveLength(2);
    expect(names[0]).toBe(name);
    expect(names[1].endsWith(' copy')).toBe(true);
    expect(names[1].length).toBeLessThanOrEqual(256);
    expect(names[1].slice(0, -5)).toBe(name.startsWith('😀') ? '😀'.repeat(125) : name.slice(0, 251));
  });
}
