// Hair: Curves objects (Add menu, Edit Mode, Sculpt Curves brushes, Object Data tab) and
// Particle Edit mode for hair particle systems.
import { test, expect, type Page } from '@playwright/test';
import { openApp, hoverViewport, expectNoErrors } from './helpers';

const get = <T>(page: Page, expr: string): Promise<T> => page.evaluate(`(() => { const app = window.app; app.flush(); return ${expr}; })()`) as Promise<T>;
const hair = `app.doc.hair_curves[app.activeObject.data]`;
const posSum = (page: Page, arr: string) => get<number>(page, `Array.from(${arr}).reduce((a, b) => a + b, 0)`);

async function stroke(page: Page, x0: number, y0: number, x1: number, y1: number) {
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 10 });
  await page.mouse.up();
}

test('hair curves: add fur, edit points, sculpt with a brush', async ({ page }) => {
  const errors = await openApp(page);
  const c = await hoverViewport(page);
  // Add ▸ Curve ▸ Fur grows hair on the selected cube
  await page.keyboard.press('Shift+A');
  await page.locator('.menu-item').filter({ hasText: /^Curve/ }).first().hover();
  await page.locator('.menu-item').filter({ hasText: /^Fur$/ }).first().click();
  expect(await get(page, 'app.activeObject.type')).toBe('CURVES');
  const curves = await get<number>(page, `${hair}.curve_offsets.length - 1`);
  expect(curves).toBeGreaterThan(1000);
  expect(await get(page, `app.graph.get(app.activeObject.id).mesh.curves.length`)).toBe(curves);

  // the Object Data tab shows the surface
  await page.locator('.rail-tab[data-tab="DATA"]').click();
  await expect(page.locator('.panel').filter({ hasText: 'Surface' }).first()).toBeVisible();

  // Edit Mode: curve selection domain, box select, delete
  await page.mouse.move(c.x, c.y);
  await page.keyboard.press('Tab');
  expect(await get(page, 'app.doc.mode')).toBe('EDIT');
  await page.locator('.hdr-row button[data-domain="CURVE"]').click();
  expect(await get(page, `${hair}.selection_domain`)).toBe('CURVE');
  await page.mouse.move(c.x, c.y);
  await page.keyboard.press('Alt+A');
  await page.keyboard.press('b');
  await page.mouse.move(c.x - 30, c.y - 140);
  await page.mouse.down();
  await page.mouse.move(c.x + 30, c.y - 30, { steps: 4 });
  await page.mouse.up();
  const picked = await get<number>(page, `Array.from(${hair}.attributes.find((a) => a.name === '.selection').data).filter((x) => x > 0).length`);
  expect(picked).toBeGreaterThan(0);
  await page.keyboard.press('x');
  expect(await get<number>(page, `${hair}.curve_offsets.length - 1`)).toBe(curves - picked);
  await page.keyboard.press('Tab');
  expect(await get(page, 'app.doc.mode')).toBe('OBJECT');

  // Sculpt Mode from the mode menu, Comb brush stroke, undo
  await page.locator('.hdr-mode').click();
  await page.locator('.menu-item').filter({ hasText: /^Sculpt Mode$/ }).first().click();
  expect(await get(page, 'app.doc.mode')).toBe('SCULPT_CURVES');
  await page.locator('.tb-tool[data-tool="builtin_brush.Comb"]').click();
  const before = await posSum(page, `${hair}.positions`);
  await stroke(page, c.x - 60, c.y - 60, c.x + 60, c.y - 50);
  const after = await posSum(page, `${hair}.positions`);
  expect(Math.abs(after - before)).toBeGreaterThan(0.01);
  await page.keyboard.press('Control+z');
  expect(Math.abs((await posSum(page, `${hair}.positions`)) - before)).toBeLessThan(1e-3);
  // F resizes the brush interactively
  await page.mouse.move(c.x, c.y);
  await page.keyboard.press('f');
  await page.mouse.move(c.x + 40, c.y);
  await page.mouse.click(c.x + 40, c.y);
  expect(await get<number>(page, `app.doc.scene.tool_settings.curves_sculpt.brushes['builtin_brush.Comb'].size`)).toBeGreaterThan(50);
  await expectNoErrors(errors);
});

test('particle edit: comb hair keys, tip select mode, context menu', async ({ page }) => {
  const errors = await openApp(page);
  const c = await hoverViewport(page);
  await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    a.run('object.particle_system_add');
    const ob = a.activeObject;
    const s = a.doc.particles[ob.particle_systems[0].settings];
    s.type = 'HAIR';
    s.count = 300;
    s.hair_length = 0.6;
    a.changed('doc');
  });
  await page.locator('.hdr-mode').click();
  await page.locator('.menu-item').filter({ hasText: /^Particle Edit$/ }).first().click();
  expect(await get(page, 'app.doc.mode')).toBe('PARTICLE_EDIT');
  const ed = 'app.activeObject.particle_systems[0].edited_hair';
  expect(await get<number>(page, `${ed}.key_offsets.length - 1`)).toBe(300);
  await page.locator('.tb-tool[data-tool="builtin.particle_comb"]').click();
  const before = await posSum(page, `${ed}.co`);
  await stroke(page, c.x - 60, c.y - 60, c.x + 60, c.y - 50);
  expect(Math.abs((await posSum(page, `${ed}.co`)) - before)).toBeGreaterThan(0.01);
  // Tip select mode (3): select all picks only the tips
  await page.mouse.move(c.x, c.y);
  await page.keyboard.press('3');
  await expect(page.locator('.hdr-row button[data-pe-mode="TIP"].on')).toBeVisible();
  await page.keyboard.press('a');
  expect(await get<number>(page, `Array.from(${ed}.select).reduce((a, b) => a + b, 0)`)).toBe(300);
  await page.keyboard.press('w');
  await expect(page.locator('.menu-item').filter({ hasText: /^Rekey$/ }).first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expectNoErrors(errors);
});
