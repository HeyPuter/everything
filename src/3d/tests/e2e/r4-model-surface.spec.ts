// NURBS surfaces: Add ▸ Surface primitives, Edit Mode on the control grid (click select, select row,
// extrude, delete), the Surface menus and the Object Data tab.
import { test, expect, type Page } from '@playwright/test';
import { openApp, hoverViewport, expectNoErrors, openHeaderMenu } from './helpers';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const ev = <T>(page: Page, fn: () => T) => page.evaluate(fn);

test('add a NURBS surface from the Add menu, edit its control grid', async ({ page }) => {
  const errors = await openApp(page);
  const view = page.locator('.area[data-editor="VIEW_3D"]').first();
  await ev(page, () => {
    const a = (window as Any).app;
    for (const o of Object.values(a.doc.objects) as Any[]) o.select = false;
  });
  await openHeaderMenu(page, view, 'Add');
  await page.locator('.menu .menu-item', { hasText: /^Surface$/ }).first().hover();
  await page.locator('.menu .menu-item', { hasText: 'NURBS Surface' }).first().click();
  const info = await ev(page, () => {
    const a = (window as Any).app;
    a.flush();
    const ob = a.activeObject;
    return { type: ob.type, name: ob.name, verts: a.graph.get(ob.id).mesh.positions.length / 3, faces: a.graph.get(ob.id).mesh.offsets.length - 1 };
  });
  expect(info).toEqual({ type: 'SURFACE', name: 'SurfPatch', verts: 256, faces: 225 });

  // Tab enters Edit Mode with the Surface menus
  await hoverViewport(page);
  await page.keyboard.press('Tab');
  await expect(view.locator('.hdr-menu', { hasText: /^Surface$/ })).toBeVisible();
  // click a control point: corner (0,0) of the grid
  await ev(page, () => (window as Any).app.run('curve.select_all', { action: 'DESELECT' }));
  await hoverViewport(page);
  const screen = await page.evaluate(async () => {
    const { activeView3D } = await import('/src/editors/view3d/view3d.ts');
    const a = (window as Any).app;
    const v = activeView3D();
    const ob = a.activeObject;
    const cu = a.doc.curves[ob.data];
    const p = cu.splines[0].points[5].co;
    const V = v!.camera.position.constructor as Any;
    const s = v!.project(new V(p[0], p[1], p[2]).applyMatrix4(a.graph.get(ob.id).world));
    const r = v!.el.getBoundingClientRect();
    return { x: s.x + r.left, y: s.y + r.top };
  });
  await page.mouse.click(screen.x, screen.y);
  expect(await ev(page, () => (window as Any).app.doc.curves[(window as Any).app.activeObject.data].splines[0].points.map((p: Any, i: number) => (p.select ? i : -1)).filter((i: number) => i >= 0))).toEqual([5]);
  // Shift Ctrl R: the row through the point (then the other direction)
  await page.keyboard.press('Shift+Control+R');
  const row1 = await ev(page, () => (window as Any).app.doc.curves[(window as Any).app.activeObject.data].splines[0].points.map((p: Any, i: number) => (p.select ? i : -1)).filter((i: number) => i >= 0));
  expect(row1.length).toBe(4);
  // select the last V row and extrude it: a fifth row
  await ev(page, () => {
    const a = (window as Any).app;
    const sp = a.doc.curves[a.activeObject.data].splines[0];
    sp.points.forEach((p: Any, i: number) => (p.select = i >= 12));
    a.changed('doc');
  });
  await hoverViewport(page);
  await page.keyboard.press('e');
  await page.keyboard.press('Escape');
  const pv = await ev(page, () => (window as Any).app.doc.curves[(window as Any).app.activeObject.data].splines[0].point_count_v);
  expect(pv).toBe(5);
  // X ▸ Vertices deletes the selected (new) row again
  await page.keyboard.press('x');
  await page.locator('.menu .menu-item', { hasText: 'Vertices' }).first().click();
  expect(await ev(page, () => (window as Any).app.doc.curves[(window as Any).app.activeObject.data].splines[0].point_count_v)).toBe(4);
  await expectNoErrors(errors);
});

test('surface primitives and operators through the API', async ({ page }) => {
  const errors = await openApp(page);
  const r = await ev(page, () => {
    const a = (window as Any).app;
    const out: Any = {};
    for (const k of ['curve', 'circle', 'surface', 'cylinder', 'sphere', 'torus']) {
      a.run(`surface.primitive_nurbs_surface_${k}_add`, { location: [0, 0, 0] }, { invoke: false });
      a.flush();
      const ob = a.activeObject;
      out[k] = a.graph.get(ob.id).mesh.positions.length / 3;
    }
    // spin a one-row curve into a closed surface of revolution
    a.run('surface.primitive_nurbs_surface_curve_add', { location: [0, 0, 0] }, { invoke: false });
    a.run('object.mode_set', { mode: 'EDIT' });
    a.run('curve.select_all', { action: 'SELECT' });
    out.spin = a.run('curve.spin', { center: [0, 0, 0], axis: [1, 0, 0] }, { invoke: false });
    const sp = a.doc.curves[a.activeObject.data].splines[0];
    out.spun = [sp.point_count_u, sp.point_count_v, sp.use_cyclic_v];
    out.cyclic = a.run('curve.cyclic_toggle', { direction: 'CYCLIC_U' }, { invoke: false });
    out.cyclicU = sp.use_cyclic_u;
    a.run('object.mode_set', { mode: 'OBJECT' });
    out.mods = a.run('object.modifier_add', { type: 'SUBSURF' });
    return out;
  });
  expect(r).toEqual({ curve: 12, circle: 32, surface: 256, cylinder: 256, sphere: 640, torus: 1024, spin: 'FINISHED', spun: [4, 8, true], cyclic: 'FINISHED', cyclicU: true, mods: 'FINISHED' });
  await expectNoErrors(errors);
});
