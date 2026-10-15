// Edit modes for curves, armatures, text and lattices: menus, shortcuts and tools.
import { test, expect, type Page } from '@playwright/test';
import { openApp, hoverViewport, expectNoErrors, viewportCenter } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const get = (page: Page, expr: string) => page.evaluate(`(() => { const app = window.app; return ${expr}; })()`);
const run = (page: Page, op: string, props: Record<string, unknown> = {}) => page.evaluate(([o, p]) => (window as any).app.run(o, p), [op, props] as const);

async function fresh(page: Page, add: string, props: Record<string, unknown> = {}) {
  await run(page, 'object.select_all', { action: 'DESELECT' });
  await run(page, add, props);
  await page.waitForTimeout(100);
  await hoverViewport(page);
}

/** Open a header menu of the 3D viewport and return its item labels. */
async function headerMenu(page: Page, name: string) {
  await page.locator('.hdr-menu', { hasText: new RegExp(`^${name.replace(/[()]/g, '\\$&')}$`) }).first().click();
  const items = await page.locator('.menu').last().locator('.menu-item').allInnerTexts();
  await page.keyboard.press('Escape');
  return items.map((t) => t.split('\n')[0].trim());
}

const CU = 'app.doc.curves[app.activeObject.data]';

test('curve edit mode: menus, selection helpers, split, dissolve, hide', async ({ page }) => {
  const errors = await openApp(page);
  await fresh(page, 'curve.primitive_bezier_circle_add');
  await page.keyboard.press('Tab');
  expect(await get(page, 'app.doc.mode')).toBe('EDIT');
  // header menus
  const curveItems = await headerMenu(page, 'Curve');
  for (const l of ['Transform', 'Mirror', 'Snap', 'Duplicate', 'Split', 'Separate', 'Toggle Cyclic', 'Set Spline Type', 'Show/Hide', 'Clean Up', 'Delete']) expect(curveItems).toContain(l);
  const sel = await headerMenu(page, 'Select');
  for (const l of ['Select Random', 'Checker Deselect', 'More', 'Less', 'Select Similar', '(De)select First', 'Select Next']) expect(sel).toContain(l);
  const cp = await headerMenu(page, 'Control Points');
  for (const l of ['Tilt', 'Clear Tilt', 'Recalculate Handles', 'Smooth', 'Smooth Curve Radius']) expect(cp).toContain(l);
  // subdivide to 8, select one point, grow with Ctrl+Numpad+
  await page.keyboard.press('a');
  await run(page, 'curve.subdivide');
  expect(await get(page, `${CU}.splines[0].bezier_points.length`)).toBe(8);
  await page.keyboard.press('Alt+a');
  await page.evaluate(() => {
    const a = (window as any).app;
    const b = a.doc.curves[a.activeObject.data].splines[0].bezier_points[2];
    b.select_control_point = b.select_left_handle = b.select_right_handle = true;
    a.changed('doc');
  });
  await page.keyboard.press('Control+NumpadAdd');
  const selIdx = () => get(page, `${CU}.splines[0].bezier_points.map((b, i) => b.select_control_point ? i : -1).filter(i => i >= 0)`);
  expect(await selIdx()).toEqual([1, 2, 3]);
  // Y splits the selected run off
  await page.keyboard.press('y');
  expect(await get(page, `${CU}.splines.map(s => s.bezier_points.length)`)).toEqual([7, 3]);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(50);
  expect(await get(page, `${CU}.splines.length`)).toBe(1);
  // Ctrl+X dissolves
  await page.keyboard.press('Control+x');
  expect(await get(page, `${CU}.splines[0].bezier_points.length`)).toBe(5);
  // H hides, Alt+H reveals
  await page.keyboard.press('Alt+a');
  await run(page, 'curve.de_select_first');
  await page.keyboard.press('h');
  expect(await get(page, `${CU}.splines[0].bezier_points.filter(b => b.hide).length`)).toBe(1);
  await page.keyboard.press('Alt+h');
  expect(await get(page, `${CU}.splines[0].bezier_points.filter(b => b.hide).length`)).toBe(0);
  // Alt+S radius with typed value, Ctrl+T tilt
  await page.keyboard.press('a');
  await page.keyboard.press('Alt+s');
  await page.keyboard.type('2');
  await page.keyboard.press('Enter');
  expect(await get(page, `${CU}.splines[0].bezier_points.map(b => b.radius)`)).toEqual([2, 2, 2, 2, 2]);
  await page.keyboard.press('Control+t');
  await page.keyboard.type('30');
  await page.keyboard.press('Enter');
  expect(await get(page, `+${CU}.splines[0].bezier_points[0].tilt.toFixed(4)`)).toBeCloseTo(Math.PI / 6, 3);
  await page.keyboard.press('Alt+t');
  expect(await get(page, `${CU}.splines[0].bezier_points[0].tilt`)).toBe(0);
  // mirror in edit mode
  const x0 = await get(page, `${CU}.splines[0].bezier_points.map(b => +b.co[0].toFixed(3))`);
  await run(page, 'transform.mirror', { axis: 0 });
  const x1 = await get(page, `${CU}.splines[0].bezier_points.map(b => +b.co[0].toFixed(3))`);
  expect((x1 as number[]).map((v) => -v + 0).sort()).toEqual((x0 as number[]).map((v) => v + 0).sort());
  await expectNoErrors(errors);
});

test('curve edit mode: toolbar draw and pen tools', async ({ page }) => {
  const errors = await openApp(page);
  await fresh(page, 'curve.primitive_bezier_curve_add');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Alt+a');
  await page.waitForSelector('.v3d-toolbar .tb-tool[data-tool="builtin.draw"]');
  const tools = await page.locator('.v3d-toolbar .tb-tool').evaluateAll((els) => els.map((e) => e.getAttribute('data-tool')));
  for (const t of ['builtin.draw', 'builtin.pen', 'builtin.extrude', 'builtin.extrude_cursor', 'builtin.radius', 'builtin.tilt']) expect(tools).toContain(t);
  expect(tools).not.toContain('builtin.inset_faces');
  const { x, y } = await viewportCenter(page);
  // draw a stroke
  await page.locator('.v3d-toolbar .tb-tool[data-tool="builtin.draw"]').dispatchEvent('pointerdown');
  await page.mouse.move(x - 150, y + 40);
  await page.mouse.down();
  for (let i = 0; i <= 30; i++) await page.mouse.move(x - 150 + i * 10, y + 40 - Math.sin(i / 5) * 60);
  await page.mouse.up();
  await page.waitForTimeout(100);
  expect(await get(page, `${CU}.splines.length`)).toBe(2);
  const drawn = (await get(page, `${CU}.splines[1].bezier_points.length`)) as number;
  expect(drawn).toBeGreaterThan(1);
  expect(drawn).toBeLessThan(12);
  // pen: click twice in empty space extends the selected (last drawn) end
  await page.locator('.v3d-toolbar .tb-tool[data-tool="builtin.pen"]').dispatchEvent('pointerdown');
  await page.keyboard.press('Alt+a');
  await page.mouse.click(x - 100, y - 120);
  await page.mouse.move(x, y - 150);
  await page.mouse.down();
  await page.mouse.move(x + 40, y - 150, { steps: 4 });
  await page.mouse.up();
  expect(await get(page, `${CU}.splines.length`)).toBe(3);
  expect(await get(page, `${CU}.splines[2].bezier_points.length`)).toBe(2);
  expect(await get(page, `${CU}.splines[2].bezier_points[1].handle_right_type`)).toBe('ALIGNED');
  await expectNoErrors(errors);
});
