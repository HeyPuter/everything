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
