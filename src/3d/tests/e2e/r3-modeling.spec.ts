// Modeling round 3: primitives, interactive add tools, extrude variants, poly build, measure,
// remesh and the other new viewport / edit mode operators, driven through the UI.
import { test, expect, type Page } from '@playwright/test';
import { openApp, hoverViewport, viewportCenter, expectNoErrors } from './helpers';

const get = (page: Page, expr: string) => page.evaluate(`(() => { const app = window.app; return ${expr}; })()`);
const counts = (page: Page) => get(page, `(() => { const me = app.doc.meshes[app.activeObject.data]; return [me.positions.length / 3, me.offsets.length - 1]; })()`) as Promise<[number, number]>;

async function drag(page: Page, pts: [number, number][]) {
  await page.mouse.move(pts[0][0], pts[0][1]);
  await page.mouse.down();
  for (const [x, y] of pts.slice(1)) await page.mouse.move(x, y, { steps: 5 });
  await page.mouse.up();
}

test('Add ▸ Mesh ▸ Monkey adds the monkey head', async ({ page }) => {
  const errors = await openApp(page);
  await hoverViewport(page);
  await page.keyboard.press('Shift+a');
  await page.locator('.menu-item', { hasText: /^Mesh/ }).first().hover();
  await page.locator('.menu-item', { hasText: 'Monkey' }).first().click();
  expect(await get(page, 'app.activeObject.name')).toBe('Monkey');
  const [v, f] = await counts(page);
  expect(v).toBeGreaterThan(400);
  expect(f).toBeGreaterThan(400);
  // the redo panel offers the size
  await page.locator('.redo-panel').getByText('Add Monkey').click();
  await expect(page.locator('.redo-panel')).toContainText('Size');
  await expectNoErrors(errors);
});

test('interactive add: drag a base, lift the height, click; tool settings and edit mode', async ({ page }) => {
  const errors = await openApp(page);
  const { box } = await viewportCenter(page);
  // the add tools share one toolbar slot
  const slot = page.locator('.tb-tool[data-tool="builtin.primitive_cube_add"]');
  await expect(slot).toBeVisible();
  await slot.click({ button: 'right' });
  await page.locator('.menu-item', { hasText: 'Add Cylinder' }).first().click();
  await expect(page.locator('.tool-header')).toContainText('Orientation');
  const x = box.x + box.width - 260,
    y = box.y + box.height - 220;
  await drag(page, [
    [x, y],
    [x + 60, y + 25],
    [x + 110, y + 50],
  ]);
  await page.mouse.move(x + 110, y - 30, { steps: 6 });
  await page.mouse.click(x + 110, y - 30);
  await page.waitForTimeout(100);
  expect(await get(page, 'app.activeObject.name')).toBe('Cylinder');
  const scale = (await get(page, 'app.activeObject.scale')) as number[];
  expect(scale.every((s) => s > 0.05)).toBe(true);
  expect(await get(page, 'app.lastOp.idname')).toBe('mesh.primitive_cylinder_add');
  // a fixed base aspect gives a square base
  await page.locator('.add-shape-btn').dispatchEvent('pointerdown');
  await page.locator('.add-shape-pop button', { hasText: 'Fixed' }).first().click();
  await page.keyboard.press('Escape');
  // the same tool adds into the edited mesh in Edit Mode
  await page.evaluate(() => (window as any).app.run('object.mode_set', { mode: 'EDIT' })); // eslint-disable-line @typescript-eslint/no-explicit-any
  const before = (await counts(page))[0];
  await page.locator('.tb-tool[data-tool="builtin.primitive_cylinder_add"]').click();
  await drag(page, [
    [x - 200, y],
    [x - 150, y + 30],
  ]);
  await page.mouse.move(x - 150, y - 50, { steps: 6 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  expect((await counts(page))[0]).toBe(before + 64);
  await expectNoErrors(errors);
});

test('poly build: hover preview, split an edge at the cursor and dissolve it again', async ({ page }) => {
  const errors = await openApp(page);
  await hoverViewport(page);
  await page.keyboard.press('Tab');
  await page.locator('.tb-tool[data-tool="builtin.poly_build"]').click();
  // the middle of the edge between two projected cube corners
  const { box } = await viewportCenter(page);
  const at = await page.evaluate(async () => {
    const { activeView3D } = await import('/src/editors/view3d/view3d.ts' as string);
    const v = activeView3D();
    const Vector3 = v.nav.pivot.constructor;
    const a = v.project(new Vector3(1, 1, 1)),
      b = v.project(new Vector3(1, -1, 1));
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  });
  await page.mouse.move(box.x + at.x, box.y + at.y);
  await expect(page.locator('.polybuild-preview')).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).app.run('mesh.polybuild_split_at_cursor', {}, { invoke: true }))).toBe('FINISHED'); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect((await counts(page))[0]).toBe(9);
  expect(await page.evaluate(() => (window as any).app.run('mesh.polybuild_dissolve_at_cursor', {}, { invoke: true }))).toBe('FINISHED'); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect((await counts(page))[0]).toBe(8);
  await expectNoErrors(errors);
});
