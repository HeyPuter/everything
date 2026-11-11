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

test('the viewport comes back after the graphics context is restored', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(async () => {
    const { renderContext } = await import('/src/render/context.ts' as string);
    renderContext.engine.renderer.forceContextLoss();
  });
  await expect(page.locator('.error-screen')).toBeVisible();
  await page.evaluate(async () => {
    const { renderContext } = await import('/src/render/context.ts' as string);
    renderContext.engine.renderer.forceContextRestore();
  });
  await expect(page.locator('.error-screen')).toHaveCount(0);
  const r = await page.evaluate(async () => {
    const { renderContext } = await import('/src/render/context.ts' as string);
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const eng = renderContext.engine;
    a.run('view3d.toggle_shading', { type: 'MATERIAL' });
    a.changed('doc');
    a.flush();
    eng.drawAll();
    // the cube in the middle of the view is drawn again (not the empty canvas colour)
    const gl = eng.renderer.getContext() as WebGL2RenderingContext;
    const v = document.querySelector('.view3d')!.getBoundingClientRect();
    const base = eng.canvas.getBoundingClientRect();
    const px = new Uint8Array(4);
    gl.readPixels(Math.round((v.left + v.width / 2 - base.left) * eng.dpr), Math.round((base.bottom - v.top - v.height / 2) * eng.dpr), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return { lost: eng.lost, px: [...px] };
  });
  expect(r.lost).toBe(false);
  expect(r.px.slice(0, 3).some((c) => c > 60)).toBe(true);
  await expectNoErrors(errors);
});

test('the viewport follows a device pixel ratio change (window moved to another display)', async ({ page }) => {
  const errors = await openApp(page);
  const size = page.viewportSize()!;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 2, mobile: false });
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { renderContext } = await import('/src/render/context.ts' as string);
        const eng = renderContext.engine;
        return { dpr: eng.dpr, ratio: Math.round((eng.canvas.width / eng.canvas.clientWidth) * 10) / 10 };
      }),
    )
    .toEqual({ dpr: 2, ratio: 2 });
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await expectNoErrors(errors);
});

test('View Camera in a new empty scene does not borrow another scene camera', async ({ page }) => {
  const errors = await openApp(page);
  await hoverViewport(page);
  const r = await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    a.run('scene.new', { type: 'NEW' });
    a.flush();
    const res = a.run('view3d.view_camera');
    return { res, camera: a.doc.scene.camera };
  });
  expect(r).toEqual({ res: 'CANCELLED', camera: null });
  await expectNoErrors(errors);
});

test('cancelled pen drags of the circle select tool and the navigation gizmo stop following the pointer', async ({ page }) => {
  const errors = await openApp(page);
  const c = await hoverViewport(page);
  const pen = (sel: string, x: number, y: number) =>
    page.evaluate(
      ([sel, x, y]) => {
        const el = document.querySelector(sel as string) as Element;
        const init = { bubbles: true, clientX: x as number, clientY: y as number, pointerId: 9, pointerType: 'pen', button: 0, buttons: 1, isPrimary: true };
        el.dispatchEvent(new PointerEvent('pointerdown', init));
        window.dispatchEvent(new PointerEvent('pointercancel', { ...init, buttons: 0 }));
      },
      [sel, x, y] as const,
    );
  // circle select: a cancelled stroke does not keep selecting under the mouse afterwards
  await page.evaluate(async () => {
    const { setActiveTool } = await import('/src/editors/view3d/toolbar.ts' as string);
    setActiveTool('builtin.select_circle');
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    for (const o of Object.values(a.doc.objects) as any[]) o.select = false; // eslint-disable-line @typescript-eslint/no-explicit-any
    a.changed('select');
  });
  await pen('.view3d', c.box.x + 30, c.box.y + c.box.height - 30);
  await page.mouse.move(c.x, c.y, { steps: 5 });
  expect(await page.evaluate(() => Object.values((window as any).app.doc.objects).filter((o: any) => o.select).length)).toBe(0); // eslint-disable-line @typescript-eslint/no-explicit-any
  // navigation gizmo: the view does not turn with later mouse motion
  const g = (await page.locator('.view3d .nav-gizmo').first().boundingBox())!;
  const rot = () => page.evaluate(async () => (await import('/src/editors/view3d/view3d.ts' as string)).activeView3D().nav.rot.toArray().map((x: number) => +x.toFixed(5)));
  const r0 = await rot();
  await pen('.view3d .nav-gizmo', g.x + g.width / 2 + 5, g.y + g.height / 2 + 5);
  await page.mouse.move(c.x - 100, c.y + 50, { steps: 5 });
  expect(await rot()).toEqual(r0);
  await expectNoErrors(errors);
});

test('a cancelled pen drag on the move gizmo cancels the move', async ({ page }) => {
  const errors = await openApp(page);
  await hoverViewport(page);
  await page.evaluate(async () => {
    const { setActiveTool } = await import('/src/editors/view3d/toolbar.ts' as string);
    setActiveTool('builtin.move');
    (window as any).app.changed('ui'); // eslint-disable-line @typescript-eslint/no-explicit-any
  });
  const arrow = page.locator('.view3d [data-gizmo="move:0"]').first();
  await expect(arrow).toBeAttached();
  const b = (await arrow.boundingBox())!;
  await page.evaluate(
    ([x, y]) => {
      const el = document.querySelector('.view3d [data-gizmo="move:0"]') as Element;
      const init = { bubbles: true, clientX: x, clientY: y, pointerId: 11, pointerType: 'pen', button: 0, buttons: 1, isPrimary: true };
      el.dispatchEvent(new PointerEvent('pointerdown', init));
      window.dispatchEvent(new PointerEvent('pointermove', { ...init, clientX: x + 80 }));
      window.dispatchEvent(new PointerEvent('pointercancel', { ...init, clientX: x + 80, buttons: 0 }));
    },
    [b.x + b.width / 2, b.y + b.height / 2],
  );
  expect(await page.evaluate(() => ({ modal: !!(window as any).app.modal, loc: (window as any).app.activeObject.location }))).toEqual({ modal: false, loc: [0, 0, 0] }); // eslint-disable-line @typescript-eslint/no-explicit-any
  await expectNoErrors(errors);
});
