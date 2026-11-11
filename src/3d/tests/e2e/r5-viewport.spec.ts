// 3D Viewport review (round 5): rendering resources and navigation edge cases.
import { test, expect } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

test('changing the world colour in Rendered shading does not leak GPU resources', async ({ page }) => {
  const errors = await openApp(page);
  const mem = await page.evaluate(async () => {
    const { renderContext } = await import('/src/render/context.ts' as string);
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const eng = renderContext.engine;
    a.run('view3d.toggle_shading', { type: 'RENDERED' });
    const w = a.doc.worlds[a.doc.scene.world];
    w.use_nodes = false;
    const frame = () => {
      a.changed('doc');
      a.flush();
      eng.drawAll();
    };
    frame();
    const before = { ...eng.renderer.info.memory };
    for (let i = 0; i < 20; i++) {
      w.color = [i / 20, 0.2, 0.3];
      frame();
    }
    return { before, after: { ...eng.renderer.info.memory } };
  });
  expect(mem.after.geometries - mem.before.geometries).toBeLessThan(5);
  expect(mem.after.textures - mem.before.textures).toBeLessThan(5);
  await expectNoErrors(errors);
});
