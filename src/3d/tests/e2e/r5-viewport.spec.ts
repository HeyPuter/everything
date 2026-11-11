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

test('Local View: select all, box select and Frame All only affect the local objects', async ({ page }) => {
  const errors = await openApp(page);
  const c = await hoverViewport(page);
  await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    a.run('mesh.primitive_cube_add', { location: [20, 0, 0] });
    const far = a.activeObject;
    far.name = 'Far';
    // Far stays selected while the view goes local on the Cube
    for (const o of Object.values(a.doc.objects) as any[]) o.select = o.name === 'Cube'; // eslint-disable-line @typescript-eslint/no-explicit-any
    a.doc.scene.active_object = Object.values(a.doc.objects).find((o: any) => o.name === 'Cube')!.id; // eslint-disable-line @typescript-eslint/no-explicit-any
    a.flush();
    a.run('view3d.localview');
    far.select = true;
    a.changed('select');
    a.flush();
  });
  const selected = () => page.evaluate(() => Object.values((window as any).app.doc.objects).filter((o: any) => o.select).map((o: any) => o.name).sort()); // eslint-disable-line @typescript-eslint/no-explicit-any
  // Alt+A deselects only what Local View shows
  await page.mouse.move(c.x, c.y);
  await page.keyboard.press('Alt+A');
  expect(await selected()).toEqual(['Far']);
  await page.keyboard.press('A');
  expect(await selected()).toEqual(['Cube', 'Far']);
  // a box drag over empty space deselects the local objects only
  await page.mouse.move(c.box.x + 20, c.box.y + c.box.height - 60);
  await page.mouse.down();
  await page.mouse.move(c.box.x + 60, c.box.y + c.box.height - 30, { steps: 4 });
  await page.mouse.up();
  expect(await selected()).toEqual(['Far']);
  // Home frames the Cube, not the far object
  await page.evaluate(() => (window as any).app.run('view3d.view_all')); // eslint-disable-line @typescript-eslint/no-explicit-any
  await expect
    .poll(() => page.evaluate(async () => (await import('/src/editors/view3d/view3d.ts' as string)).activeView3D().nav.pivot.x), { timeout: 5000 })
    .toBeCloseTo(0, 3);
  await expectNoErrors(errors);
});

test('a cancelled pen/touch press in the viewport does not select later', async ({ page }) => {
  const errors = await openApp(page);
  const c = await hoverViewport(page);
  const selected = () => page.evaluate(() => Object.values((window as any).app.doc.objects).filter((o: any) => o.select).map((o: any) => o.name)); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(await selected()).toEqual(['Cube']);
  // a pen press on empty space that the system cancels (palm rejection, gesture)
  const x = c.box.x + 40,
    y = c.box.y + c.box.height - 40;
  await page.evaluate(
    ([x, y]) => {
      const el = document.querySelector('.view3d') as HTMLElement;
      const init = { bubbles: true, clientX: x, clientY: y, pointerId: 7, pointerType: 'pen', button: 0, buttons: 1, isPrimary: true };
      el.dispatchEvent(new PointerEvent('pointerdown', init));
      el.dispatchEvent(new PointerEvent('pointermove', { ...init, clientX: x + 30, clientY: y - 30 }));
      el.dispatchEvent(new PointerEvent('pointercancel', { ...init, buttons: 0 }));
    },
    [x, y],
  );
  expect(await page.locator('.view3d .select-box:not([hidden])').count()).toBe(0);
  // a later release (e.g. of a click elsewhere) must not finish that selection
  await page.evaluate(([x, y]) => window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x + 60, clientY: y - 60, pointerId: 1, button: 0 })), [x, y]);
  expect(await selected()).toEqual(['Cube']);
  await expectNoErrors(errors);
});
