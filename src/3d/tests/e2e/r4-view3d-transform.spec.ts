// Transform modal: B picks the snap base on the moving geometry, A adds snap points.
import { test, expect, type Page } from '@playwright/test';
import { openApp, hoverViewport, expectNoErrors } from './helpers';

const get = <T = unknown>(page: Page, expr: string) => page.evaluate(`(() => { const app = window.app; return ${expr}; })()`) as Promise<T>;

async function screenOf(page: Page, p: [number, number, number]) {
  return page.evaluate((pt) => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const v = (a.hoverArea ?? a.activeArea).editor;
    const r = v.el.getBoundingClientRect();
    const s = v.project(v.nav.pivot.clone().set(pt[0], pt[1], pt[2]));
    return { x: r.left + s.x, y: r.top + s.y };
  }, p);
}

async function setup(page: Page) {
  await page.evaluate(() => {
    const app = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const ts = app.doc.scene.tool_settings;
    ts.use_snap = true;
    ts.snap_elements = ['VERTEX'];
    ts.snap_target = 'MEDIAN';
    // a second cube to snap to
    const cube = app.activeObject;
    app.run('mesh.primitive_cube_add', { size: 2, location: [0, 4, 0] });
    for (const o of Object.values(app.doc.objects) as any[]) o.select = o === cube; // eslint-disable-line @typescript-eslint/no-explicit-any
    app.doc.scene.active_object = cube.id;
    app.changed('doc', 'select');
  });
}

test('B sets the snap base on the moving object', async ({ page }) => {
  const errors = await openApp(page);
  await hoverViewport(page);
  await setup(page);
  const c = await screenOf(page, [0, 0, 0]);
  await page.mouse.move(c.x, c.y);
  await page.keyboard.press('g');
  await page.keyboard.press('b');
  // pick the moving cube's corner (1, 1, 1) as the base
  const corner = await screenOf(page, [1, 1, 1]);
  await page.mouse.move(corner.x + 2, corner.y + 1, { steps: 3 });
  await page.mouse.move(corner.x, corner.y, { steps: 2 });
  await page.mouse.down();
  await page.mouse.up();
  // then snap it onto the other cube's corner (-1, 3, 1)
  const target = await screenOf(page, [-1, 3, 1]);
  await page.mouse.move(target.x + 3, target.y + 3, { steps: 4 });
  await page.mouse.move(target.x, target.y, { steps: 2 });
  await page.mouse.down();
  await page.mouse.up();
  const loc = await get<number[]>(page, 'app.activeObject.location.map(v => Math.round(v * 1000) / 1000)');
  expect(loc).toEqual([-2, 2, 0]);
  await expectNoErrors(errors);
});

test('A adds snap points: the target is their average', async ({ page }) => {
  const errors = await openApp(page);
  await hoverViewport(page);
  await setup(page);
  const c = await screenOf(page, [0, 0, 0]);
  await page.mouse.move(c.x, c.y);
  await page.keyboard.press('g');
  for (const p of [
    [-1, 3, 1],
    [1, 3, 1],
  ] as [number, number, number][]) {
    const s = await screenOf(page, p);
    await page.mouse.move(s.x + 3, s.y + 2, { steps: 3 });
    await page.mouse.move(s.x, s.y, { steps: 2 });
    await page.keyboard.press('a');
  }
  // away from any vertex the target stays at the average of the added points (0, 3, 1)
  await page.mouse.move(c.x + 5, c.y + 150, { steps: 3 });
  await page.keyboard.press('Enter');
  const loc = await get<number[]>(page, 'app.activeObject.location.map(v => Math.round(v * 1000) / 1000)');
  // the median of the cube (its origin) lands on the average
  expect(loc).toEqual([0, 3, 1]);
  await expectNoErrors(errors);
});

test('transform tool settings: gizmo orientation slot and drag action', async ({ page }) => {
  const errors = await openApp(page);
  await hoverViewport(page);
  await page.evaluate(() => {
    const app = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    app.activeObject.rotation_euler = [0, 0, Math.PI / 4];
    app.run('wm.tool_set_by_id', { name: 'builtin.move' });
    app.changed('doc');
  });
  await page.waitForTimeout(150);
  const arrow = async () => {
    const b = await page.locator('.v3d-svg [data-gizmo="move:0"]').first().boundingBox();
    return b!;
  };
  const g = await arrow();
  // the tool header shows the orientation and drag settings
  await expect(page.locator('.th-transform')).toContainText('Orientation:');
  await page.evaluate(() => {
    const app = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    app.doc.scene.transform_orientation_slots = { move: 'LOCAL' };
    app.changed('ui', 'doc');
    (app.hoverArea ?? app.activeArea).editor.drawSvg();
  });
  await page.waitForTimeout(100);
  const l = await arrow();
  expect(Math.abs(l.x - g.x) + Math.abs(l.y - g.y) + Math.abs(l.width - g.width)).toBeGreaterThan(3);
  // dragging the local X arrow moves along the object's own X axis
  const h = page.locator('.v3d-svg path[data-gizmo="move:0"]').first();
  const hb = (await h.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 + 40, hb.y + hb.height / 2 + 5, { steps: 5 });
  await page.mouse.up();
  const loc = await get<number[]>(page, 'app.activeObject.location');
  expect(Math.abs(loc[0])).toBeGreaterThan(0.01);
  expect(loc[0]).toBeCloseTo(loc[1], 3);
  await expectNoErrors(errors);
});

test('Scale Cage scales from the opposite side of the selection box', async ({ page }) => {
  const errors = await openApp(page);
  await hoverViewport(page);
  await page.evaluate(() => (window as any).app.run('wm.tool_set_by_id', { name: 'builtin.scale_cage' })); // eslint-disable-line @typescript-eslint/no-explicit-any
  await page.waitForTimeout(150);
  const h = page.locator('.v3d-svg [data-gizmo="cage:1,0,0"]').first();
  await expect(h).toBeVisible();
  const b = (await h.boundingBox())!;
  const x = b.x + b.width / 2,
    y = b.y + b.height / 2;
  // drag the +X face handle away from the box
  const far = await screenOf(page, [3, 0, 0]);
  const dx = far.x - x,
    dy = far.y - y,
    l = Math.hypot(dx, dy);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + (dx / l) * 40, y + (dy / l) * 40, { steps: 6 });
  await page.mouse.up();
  const ob = await get<{ scale: number[]; location: number[] }>(page, '({ scale: app.activeObject.scale, location: app.activeObject.location })');
  expect(ob.scale[0]).toBeGreaterThan(1.05);
  expect(ob.scale[1]).toBeCloseTo(1, 5);
  // the -X face stays in place: the centre moves by the growth
  expect(ob.location[0]).toBeCloseTo(ob.scale[0] - 1, 3);
  await expectNoErrors(errors);
});
