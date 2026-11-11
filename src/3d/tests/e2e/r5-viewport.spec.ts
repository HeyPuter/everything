// 3D Viewport review (round 5): rendering resources and navigation edge cases.
import { test, expect } from '@playwright/test';
import { openApp, hoverViewport, expectNoErrors } from './helpers';

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

test('rebuilt and deleted object geometry is freed on the GPU', async ({ page }) => {
  const errors = await openApp(page);
  const r = await page.evaluate(async () => {
    const { renderContext } = await import('/src/render/context.ts' as string);
    const { newModifier } = await import('/src/eval/modifiers.ts' as string);
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const eng = renderContext.engine;
    const geos = () => eng.renderer.info.memory.geometries;
    const draw = () => {
      a.changed('doc');
      a.flush();
      eng.drawAll();
    };
    draw();
    // an animated deforming modifier rebuilds the geometry every frame
    a.activeObject.modifiers.push(newModifier('WAVE', 'mdw', a.activeObject.modifiers));
    draw();
    let g0 = geos();
    for (let f = 1; f <= 20; f++) {
      a.setFrame(f);
      draw();
    }
    const frames = geos() - g0;
    // added then deleted objects of several types
    g0 = geos();
    const before = new Set(Object.keys(a.doc.objects));
    for (let i = 0; i < 5; i++) {
      a.run('mesh.primitive_uv_sphere_add', { segments: 8, ring_count: 6, location: [i, 3, 0] });
      a.run('curve.primitive_bezier_curve_add', { location: [i, 6, 0] });
      a.run('object.armature_add', { location: [i, 9, 0] });
    }
    draw();
    a.run('object.select_all', { action: 'DESELECT' });
    for (const o of Object.values(a.doc.objects) as any[]) if (!before.has(o.id)) o.select = true; // eslint-disable-line @typescript-eslint/no-explicit-any
    a.run('object.delete', { confirm: false }, { invoke: false });
    draw();
    return { frames, deleted: geos() - g0 };
  });
  expect(r.frames).toBeLessThan(5);
  expect(r.deleted).toBeLessThan(5);
  await expectNoErrors(errors);
});
