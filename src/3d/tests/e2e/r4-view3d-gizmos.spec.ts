// Object data gizmos: light look-at / spot size / radius / area size, camera lens and focus
// distance, image empty size; the Gizmos popover switches them off.
import { test, expect, type Page } from '@playwright/test';
import { openApp, hoverViewport, expectNoErrors } from './helpers';

const get = <T = unknown>(page: Page, expr: string) => page.evaluate(`(() => { const app = window.app; return ${expr}; })()`) as Promise<T>;

async function addActive(page: Page, op: string, props: Record<string, unknown>) {
  await page.evaluate(
    ([o, p]) => {
      const app = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
      app.run(o, p);
      const v = (app.hoverArea ?? app.activeArea).editor;
      v.drawSvg();
    },
    [op, props] as const,
  );
}

async function drag(page: Page, sel: string, dx: number, dy: number) {
  const h = page.locator(`.v3d-svg [data-ogz="${sel}"]`).first();
  await expect(h).toBeVisible();
  const b = (await h.boundingBox())!;
  const x = b.x + b.width / 2,
    y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 3 });
  await page.mouse.move(x + dx, y + dy, { steps: 3 });
  await page.mouse.up();
}

test('spot light gizmos: look at, size, blend, radius', async ({ page }) => {
  const errors = await openApp(page);
  await hoverViewport(page);
  await addActive(page, 'object.light_add', { type: 'SPOT', location: [0, 0, 3], rotation: [0, 0, 0] });
  const size0 = await get<number>(page, 'app.doc.lights[app.activeObject.data].spot_size');
  await drag(page, 'spot_size', 40, 0);
  const size1 = await get<number>(page, 'app.doc.lights[app.activeObject.data].spot_size');
  expect(Math.abs(size1 - size0)).toBeGreaterThan(0.05);
  await drag(page, 'radius', 30, 30);
  expect(await get<number>(page, 'app.doc.lights[app.activeObject.data].shadow_soft_size')).not.toBeCloseTo(0.1, 3);
  const rot0 = await get<number[]>(page, 'app.activeObject.rotation_euler.slice()');
  await drag(page, 'look_at', 120, 0);
  const rot1 = await get<number[]>(page, 'app.activeObject.rotation_euler.slice()');
  expect(rot1.some((r, i) => Math.abs(r - rot0[i]) > 0.05)).toBe(true);
  // Escape cancels a drag
  const blend0 = await get<number>(page, 'app.doc.lights[app.activeObject.data].spot_blend');
  const h = page.locator('.v3d-svg [data-ogz="spot_blend"]').first();
  const b = (await h.boundingBox())!;
  await page.mouse.move(b.x + 4, b.y + 4);
  await page.mouse.down();
  await page.mouse.move(b.x + 60, b.y + 4, { steps: 4 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect(await get<number>(page, 'app.doc.lights[app.activeObject.data].spot_blend')).toBeCloseTo(blend0, 6);
  await expectNoErrors(errors);
});

test('area light size and camera lens / focus gizmos', async ({ page }) => {
  const errors = await openApp(page);
  await hoverViewport(page);
  await addActive(page, 'object.light_add', { type: 'AREA', location: [0, 0, 1] });
  await drag(page, 'area_x', 40, 0);
  expect(await get<number>(page, 'app.doc.lights[app.activeObject.data].size')).not.toBeCloseTo(1, 2);
  await addActive(page, 'object.camera_add', { location: [0, -3, 1], rotation: [1.3, 0, 0] });
  const lens0 = await get<number>(page, 'app.doc.cameras[app.activeObject.data].lens');
  await drag(page, 'lens', 30, -30);
  expect(await get<number>(page, 'app.doc.cameras[app.activeObject.data].lens')).not.toBeCloseTo(lens0, 1);
  // focus distance handle appears with depth of field
  await page.evaluate(() => {
    const app = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    app.doc.cameras[app.activeObject.data].dof.use_dof = true;
    app.doc.cameras[app.activeObject.data].dof.focus_distance = 3;
    app.changed('doc');
    (app.hoverArea ?? app.activeArea).editor.drawSvg();
  });
  await drag(page, 'focus', 0, -40);
  expect(await get<number>(page, 'app.doc.cameras[app.activeObject.data].dof.focus_distance')).not.toBeCloseTo(3, 2);
  await expectNoErrors(errors);
});

test('Gizmos popover hides the object data gizmos', async ({ page }) => {
  const errors = await openApp(page);
  await hoverViewport(page);
  await addActive(page, 'object.light_add', { type: 'SPOT', location: [0, 0, 3] });
  await expect(page.locator('.v3d-svg [data-ogz="look_at"]')).toHaveCount(1);
  await page.locator('[data-tip="Gizmos"]').first().click();
  await page.locator('.popover, .pop-panel').getByText('Look At').click();
  await expect(page.locator('.v3d-svg [data-ogz="look_at"]')).toHaveCount(0);
  await expect(page.locator('.v3d-svg [data-ogz="spot_size"]')).toHaveCount(1);
  await page.locator('.popover, .pop-panel').getByText('Active Object').click();
  await expect(page.locator('.v3d-svg [data-ogz]')).toHaveCount(0);
  await expectNoErrors(errors);
});
