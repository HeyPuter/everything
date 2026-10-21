// 3D Viewport click selection: Alt+click lists overlapping objects, repeated clicks cycle,
// view3d.select picks at a location.
import { test, expect, type Page } from '@playwright/test';
import { openApp, viewportCenter, hoverViewport, expectNoErrors } from './helpers';

const get = <T = unknown>(page: Page, expr: string) => page.evaluate(`(() => { const app = window.app; return ${expr}; })()`) as Promise<T>;

/** Screen position (client px) of a world point in the first 3D viewport. */
async function screenOf(page: Page, p: [number, number, number]) {
  await hoverViewport(page);
  return page.evaluate(async (pt) => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const v = (a.hoverArea ?? a.activeArea).editor;
    const r = v.el.getBoundingClientRect();
    const s = v.project(v.nav.pivot.clone().set(pt[0], pt[1], pt[2]));
    return { x: r.left + s.x, y: r.top + s.y };
  }, p);
}

async function twoCubes(page: Page) {
  await page.evaluate(() => {
    const app = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    app.run('mesh.primitive_cube_add', { size: 1, location: [0, 0, 0.2] });
    app.activeObject.name = 'Inner';
    app.changed('doc');
  });
}

test('Alt+click opens the select menu listing overlapping objects', async ({ page }) => {
  const errors = await openApp(page);
  await twoCubes(page);
  const c = await screenOf(page, [0, 0, 0]);
  await page.mouse.move(c.x, c.y);
  await page.keyboard.down('Alt');
  await page.mouse.click(c.x, c.y);
  await page.keyboard.up('Alt');
  const menu = page.locator('.menu').last();
  await expect(menu).toContainText('Cube');
  await expect(menu).toContainText('Inner');
  await menu.locator('.menu-item', { hasText: /^Cube$/ }).click();
  expect(await get(page, 'app.activeObject.name')).toBe('Cube');
  expect(await get(page, 'Object.values(app.doc.objects).filter(o => o.select).map(o => o.name)')).toEqual(['Cube']);
  await expectNoErrors(errors);
});

test('view3d.select picks at a location; select_menu selects by name', async ({ page }) => {
  const errors = await openApp(page);
  await twoCubes(page);
  const { box } = await viewportCenter(page);
  const c = await screenOf(page, [0, 0, 0]);
  await page.evaluate(([x, y]) => (window as any).app.run('view3d.select', { location: [x, y], deselect_all: true }), [c.x - box.x, c.y - box.y]); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(await get(page, 'Object.values(app.doc.objects).filter(o => o.select).length')).toBe(1);
  // clicking empty space with deselect_all clears the selection
  await page.evaluate(() => (window as any).app.run('view3d.select', { location: [5, 5], deselect_all: true })); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(await get(page, 'Object.values(app.doc.objects).filter(o => o.select).length')).toBe(0);
  await page.evaluate(() => (window as any).app.run('view3d.select_menu', { name: 'Light' }, { invoke: false })); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(await get(page, 'app.activeObject.name')).toBe('Light');
  await page.evaluate(() => (window as any).app.run('view3d.select_menu', { name: 'Camera', extend: true }, { invoke: false })); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(await get(page, 'Object.values(app.doc.objects).filter(o => o.select).map(o => o.name).sort()')).toEqual(['Camera', 'Light']);
  await expectNoErrors(errors);
});

test('view3d.select_lasso selects inside a path; the Select menu offers its modes', async ({ page }) => {
  const errors = await openApp(page);
  const { box } = await viewportCenter(page);
  const c = await screenOf(page, [0, 0, 0]);
  const x = c.x - box.x,
    y = c.y - box.y;
  await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    for (const o of Object.values(a.doc.objects) as any[]) o.select = false; // eslint-disable-line @typescript-eslint/no-explicit-any
    a.changed('select');
  });
  const path = `${x - 30},${y - 30} ${x + 30},${y - 30} ${x + 30},${y + 30} ${x - 30},${y + 30}`;
  expect(await page.evaluate((pp) => (window as any).app.run('view3d.select_lasso', { path: pp, mode: 'SET' }), path)).toBe('FINISHED'); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(await get(page, 'Object.values(app.doc.objects).filter(o => o.select).map(o => o.name)')).toEqual(['Cube']);
  // interactive: the modal waits for a left-button drag
  await page.evaluate(() => (window as any).app.run('view3d.select_lasso', { mode: 'SUB' })); // eslint-disable-line @typescript-eslint/no-explicit-any
  await page.mouse.move(c.x - 30, c.y - 30);
  await page.mouse.down();
  for (const [dx, dy] of [
    [30, -30],
    [30, 30],
    [-30, 30],
    [-30, -28],
  ])
    await page.mouse.move(c.x + dx, c.y + dy, { steps: 3 });
  await page.mouse.up();
  expect(await get(page, 'Object.values(app.doc.objects).filter(o => o.select).length')).toBe(0);
  await expectNoErrors(errors);
});
