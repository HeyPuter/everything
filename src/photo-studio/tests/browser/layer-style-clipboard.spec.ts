// Copy Layer Style / Paste Layer Style across documents.
import { expect, test } from '@playwright/test';
import { boot, compositePixel, idle, openImage, run } from './helpers';

test('a pasted pattern overlay brings its document pattern into the other document', async ({
  page,
}) => {
  await boot(page);
  await openImage(page, 64, 64, '#ffffff', 'target.png');
  await openImage(page, 64, 64, '#ffffff', 'source.png');
  // In the source: a red document pattern used by a pattern overlay.
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { gridFromImage } = await import('/src/model/tiles.ts');
    const data = new Uint8ClampedArray(8 * 8 * 4);
    for (let i = 0; i < data.length; i += 4) data.set([255, 0, 0, 255], i);
    const grid = gridFromImage(e.assets.tiles, { width: 8, height: 8, data });
    const id = 'user-red-pattern';
    const l = e.doc.layers[0];
    e.command('Pattern style', (d) => {
      d.patterns = [{ id, name: 'Red', width: 8, height: 8, grid }];
      const x = d.layers.find((y) => y.id === l.id)!;
      x.style = {
        enabled: true,
        patternOverlay: {
          enabled: true,
          blendMode: 'normal',
          opacity: 1,
          patternId: id,
          scale: 1,
          linkWithLayer: true,
        },
      };
    });
    e.selectLayers([l.id]);
  });
  await idle(page);
  expect(await compositePixel(page, 10, 10)).toEqual([255, 0, 0, 255]);
  await run(page, 'layer.style-copy');
  await page.evaluate(async () => {
    const e = window.photoStudio;
    await e.switchSession(e.sessions.find((s) => s.doc.name.startsWith('target'))!);
    e.selectLayers([e.doc.layers[0].id]);
  });
  await run(page, 'layer.style-paste');
  expect(await page.evaluate(() => window.photoStudio.doc.patterns?.map((p) => p.id))).toEqual([
    'user-red-pattern',
  ]);
  expect(await compositePixel(page, 10, 10)).toEqual([255, 0, 0, 255]);
  // Undo takes the pattern away with the style.
  await run(page, 'edit.undo');
  expect(await page.evaluate(() => window.photoStudio.doc.patterns)).toBeUndefined();
});

test('Paste Layer Style works when the last selected layer is an adjustment layer', async ({
  page,
}) => {
  await boot(page);
  await openImage(page, 64, 64, '#ffffff');
  const styled = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { layer } = await import('/src/model/document.ts');
    const a = layer('solid', 'A', 64, 64),
      b = layer('solid', 'B', 64, 64),
      adj = layer('adjustment', 'Invert', 64, 64);
    adj.adjustment = { kind: 'invert', params: {} };
    a.style = {
      enabled: true,
      colorOverlay: [
        { enabled: true, blendMode: 'normal', opacity: 1, color: { r: 255, g: 0, b: 0 } },
      ],
    };
    e.command('Add', (d) => d.layers.push(a, b, adj));
    e.selectLayers([a.id]);
    await e.runCommand('layer.style-copy');
    // B and the adjustment layer, the adjustment layer last.
    e.selectLayers([b.id, adj.id]);
    await e.runCommand('layer.style-paste');
    return e.doc.layers.map((l) => [l.name, !!l.style]);
  });
  await idle(page);
  expect(styled).toEqual([
    ['Background', false],
    ['A', true],
    ['B', true],
    ['Invert', false],
  ]);
});

test('blending options and fill opacity copy without effects', async ({ page }) => {
  await boot(page);
  await openImage(page, 64, 64, '#ffffff');
  const out = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { findCommand } = await import('/src/app/registry.ts');
    const { layer } = await import('/src/model/document.ts');
    const a = layer('solid', 'A', 64, 64),
      b = layer('solid', 'B', 64, 64);
    a.blending = { knockout: 'shallow' };
    a.fillOpacity = 0.5;
    e.command('Add', (d) => d.layers.push(a, b));
    e.selectLayers([a.id]);
    const enabled = findCommand('layer.style-copy')!.enabled!(e);
    await e.runCommand('layer.style-copy');
    e.selectLayers([b.id]);
    await e.runCommand('layer.style-paste');
    const pasted = e.doc.layers.find((l) => l.id === b.id)!;
    return {
      enabled,
      blending: pasted.blending,
      fillOpacity: pasted.fillOpacity,
      style: pasted.style,
    };
  });
  await idle(page);
  expect(out).toEqual({ enabled: true, blending: { knockout: 'shallow' }, fillOpacity: 0.5 });
});
