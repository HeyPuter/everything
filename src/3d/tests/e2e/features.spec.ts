// Feature flows: viewport tools, files, animation, scripting, sculpting, physics.
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openApp, hoverViewport, viewportCenter, objectNames, expectNoErrors } from './helpers';

const get = (page: Page, expr: string) => page.evaluate(`(() => { const app = window.app; return ${expr}; })()`);
const run = (page: Page, op: string, props: Record<string, unknown> = {}) => page.evaluate(([o, p]) => (window as any).app.run(o, p), [op, props] as const); // eslint-disable-line @typescript-eslint/no-explicit-any

async function drag(page: Page, pts: [number, number][]) {
  await page.mouse.move(...pts[0]);
  await page.mouse.down();
  for (const p of pts.slice(1)) await page.mouse.move(p[0], p[1], { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(100);
}

test('annotate, measure and add cube tools', async ({ page }) => {
  const errors = await openApp(page);
  const { box } = await viewportCenter(page);
  await page.click('[data-tool="builtin.annotate"]');
  await drag(page, [[box.x + 200, box.y + 200], [box.x + 260, box.y + 230], [box.x + 320, box.y + 200]]);
  expect(await get(page, 'app.doc.scene.annotations?.length')).toBe(1);
  await page.click('[data-tool="builtin.measure"]');
  await drag(page, [[box.x + 200, box.y + 500], [box.x + 500, box.y + 540]]);
  expect(await get(page, 'app.doc.scene.rulers?.length')).toBe(1);
  await page.click('[data-tool="builtin.primitive_cube_add"]');
  // near the right of the viewport, whatever its width
  const right = box.x + box.width - 120;
  await drag(page, [[right - 100, box.y + 520], [right, box.y + 570]]);
  await page.mouse.move(right, box.y + 480, { steps: 4 });
  await page.mouse.click(right, box.y + 480);
  await page.waitForTimeout(100);
  expect(await objectNames(page)).toContain('Cube.001');
  await expectNoErrors(errors);
});

test('save a project file and open it again', async ({ page }) => {
  const errors = await openApp(page);
  await hoverViewport(page);
  await page.keyboard.press('g');
  await page.keyboard.type('y3');
  await page.keyboard.press('Enter');
  const download = page.waitForEvent('download');
  await run(page, 'wm.save_mainfile');
  const file = await (await download).path();
  expect(file).toBeTruthy();
  const bytes = readFileSync(file!);
  expect(bytes.length).toBeGreaterThan(100);
  await run(page, 'wm.read_homefile');
  expect(await get(page, 'app.activeObject.location[1]')).toBe(0);
  page.once('filechooser', (fc) => fc.setFiles({ name: 'roundtrip.p3d', mimeType: 'application/octet-stream', buffer: bytes }));
  await page.evaluate(() => (window as any).app.run('wm.open_mainfile', {})); // eslint-disable-line @typescript-eslint/no-explicit-any
  await page.waitForFunction(() => (window as any).app.filename === 'roundtrip.p3d'); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(await get(page, 'Object.values(app.doc.objects).find(o => o.name === "Cube").location[1]')).toBeCloseTo(3);
  await expectNoErrors(errors);
});

test('keyframes animate the object over the timeline', async ({ page }) => {
  const errors = await openApp(page);
  await hoverViewport(page);
  await page.evaluate(() => (window as any).app.setFrame(1)); // eslint-disable-line @typescript-eslint/no-explicit-any
  await page.keyboard.press('i');
  await page.waitForTimeout(100);
  // some keymaps open the keying set menu on I; choose Location & Rotation & Scale if so
  const menu = page.getByText('Location, Rotation & Scale', { exact: false }).first();
  if (await menu.isVisible().catch(() => false)) await menu.click();
  await page.evaluate(() => (window as any).app.setFrame(20)); // eslint-disable-line @typescript-eslint/no-explicit-any
  await page.keyboard.press('g');
  await page.keyboard.type('x4');
  await page.keyboard.press('Enter');
  await page.keyboard.press('i');
  await page.waitForTimeout(100);
  if (await menu.isVisible().catch(() => false)) await menu.click();
  await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    a.setFrame(10);
    a.flush();
  });
  const x = (await get(page, 'app.activeObject.location[0]')) as number;
  expect(x).toBeGreaterThan(0.5);
  expect(x).toBeLessThan(3.5);
  await expectNoErrors(errors);
});

test('JavaScript console edits the scene through the bpy-style API', async ({ page }) => {
  const errors = await openApp(page);
  await page.locator('.ws-tab', { hasText: 'Scripting' }).first().click();
  await page.waitForTimeout(400);
  const console = page.locator('.py-console').first();
  await page.locator('.pc-lang button', { hasText: 'JavaScript' }).first().click();
  const input = console.locator('.pc-input');
  await input.click();
  await input.fill('bpy.data.objects["Cube"].location.z = 2.5');
  await input.press('Enter');
  await page.waitForTimeout(200);
  expect(await get(page, 'Object.values(app.doc.objects).find(o => o.name === "Cube").location[2]')).toBe(2.5);
  await expectNoErrors(errors);
});

test('sculpt stroke moves vertices and is undoable', async ({ page }) => {
  const errors = await openApp(page);
  await run(page, 'object.mode_set', { mode: 'SCULPT' });
  expect(await get(page, 'app.doc.mode')).toBe('SCULPT');
  const sum = () => get(page, `Array.from(app.doc.meshes[app.activeObject.data].positions).reduce((s, v) => s + Math.abs(v), 0)`);
  const before = (await sum()) as number;
  const c = await viewportCenter(page);
  await drag(page, [[c.x - 20, c.y - 10], [c.x, c.y], [c.x + 20, c.y + 10]]);
  const after = (await sum()) as number;
  expect(Math.abs(after - before)).toBeGreaterThan(1e-4);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  expect((await sum()) as number).toBeCloseTo(before, 4);
  await expectNoErrors(errors);
});

test('rigid body falls under gravity', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    a.activeObject.location = [0, 0, 5];
    a.changed('doc');
    a.run('rigidbody.object_add', {});
  });
  await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    a.setFrame(1);
    a.flush();
  });
  // simulation steps can be asynchronous (lazy physics engine load); poll until the cube has dropped
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
          a.setFrame(30);
          a.flush();
          return a.graph.get(a.activeObject.id).world.elements[14];
        }),
      { timeout: 15000 },
    )
    .toBeLessThan(4.5);
  await expectNoErrors(errors);
});

test("vertex snapping moves the selection onto another object's vertex", async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    a.run('object.select_all', { action: 'DESELECT' });
    a.run('mesh.primitive_cube_add', { location: [5, 0, 0], size: 1 });
    const ts = a.doc.scene.tool_settings;
    ts.use_snap = true;
    ts.snap_elements = ['VERTEX'];
    ts.snap_target = 'CLOSEST';
    a.changed('doc');
  });
  await page.waitForTimeout(100);
  // screen position of the big cube's corner (1, -1, 1)
  const corner = await page.evaluate(async () => {
    const { activeView3D } = await import('/src/editors/view3d/view3d.ts');
    const v = activeView3D()!;
    const p = v.project(v.nav.pivot.clone().set(1, -1, 1));
    const r = v.el.getBoundingClientRect();
    return { x: p.x + r.left, y: p.y + r.top };
  });
  await hoverViewport(page);
  await page.keyboard.press('g');
  await page.mouse.move(corner.x + 3, corner.y + 2, { steps: 6 });
  await page.waitForTimeout(100);
  await page.keyboard.press('Enter');
  // the small cube's closest corner now sits exactly on (1, -1, 1)
  const loc = (await page.evaluate(() => (window as any).app.activeObject.location)) as number[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  const corners = [-0.5, 0.5].flatMap((x) => [-0.5, 0.5].flatMap((y) => [-0.5, 0.5].map((z) => [loc[0] + x, loc[1] + y, loc[2] + z])));
  const best = Math.min(...corners.map((p) => Math.hypot(p[0] - 1, p[1] + 1, p[2] - 1)));
  expect(best).toBeLessThan(1e-4);
  await expectNoErrors(errors);
});
