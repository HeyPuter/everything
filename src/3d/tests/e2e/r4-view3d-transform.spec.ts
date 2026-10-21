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
