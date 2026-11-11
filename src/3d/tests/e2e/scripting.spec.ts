// Scripting in the running app: image pixels through the canvas, handlers reacting to the
// timeline, and a Text Editor script using bmesh as one undo step.
import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const get = (page: Page, expr: string) => page.evaluate(`(() => { const app = window.app; return ${expr}; })()`);

/** Types a line into the console in JavaScript mode and presses Enter. */
async function consoleLine(page: Page, code: string) {
  const input = page.locator('.py-console').first().locator('.pc-input');
  await input.click();
  await input.fill(code);
  await input.press('Enter');
  await page.waitForTimeout(100);
}

async function scriptingWorkspace(page: Page) {
  await page.locator('.ws-tab', { hasText: 'Scripting' }).first().click();
  await page.waitForTimeout(300);
  await page.locator('.pc-lang button', { hasText: 'JavaScript' }).first().click();
}

test('image pixels written by a script show up and read back', async ({ page }) => {
  const errors = await openApp(page);
  await scriptingWorkspace(page);
  await consoleLine(page, "const img = D.images.new('Checker', 4, 4); img.pixels = Array.from({length: 64}, (_, i) => (i % 4 === 3 ? 1 : ((Math.floor(i / 4) + Math.floor(i / 16)) % 2)))");
  await consoleLine(page, "window.__px = [...D.images['Checker'].pixels].slice(0, 8)");
  expect(await get(page, 'window.__px')).toEqual([0, 0, 0, 1, 1, 1, 1, 1]);
  expect(await get(page, "Object.values(app.doc.images).find(i => i.name === 'Checker').mime")).toBe('image/png');
  await expectNoErrors(errors);
});

test('a frame change handler follows the timeline', async ({ page }) => {
  const errors = await openApp(page);
  await scriptingWorkspace(page);
  await consoleLine(page, "bpy.app.handlers.frame_change_post.push(function follow(scene) { D.objects['Cube'].location.x = scene.frame_current / 10 })");
  await page.evaluate(() => (window as any).app.run('screen.frame_jump', { end: true }));
  await page.waitForTimeout(150);
  const end = (await get(page, 'app.doc.scene.frame_end')) as number;
  expect(await get(page, "Object.values(app.doc.objects).find(o => o.name === 'Cube').location[0]")).toBeCloseTo(end / 10);
  await expectNoErrors(errors);
});

test('a Text Editor script builds a mesh with bmesh in one undo step', async ({ page }) => {
  const errors = await openApp(page);
  await scriptingWorkspace(page);
  const hasBmesh = await page.evaluate(async () => !!((await import('/src/scripting/jsmodules.ts' as string)) as any).scriptModules.bmesh);
  test.skip(!hasBmesh, 'bmesh is not available');
  const box = (await page.locator('.area[data-editor="TEXT"]').first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.evaluate(() => {
    const a = (window as any).app;
    const code = [
      "const me = D.meshes.new('Stairs');",
      'const bm = bmesh.new();',
      'bmesh.ops.create_cube(bm, {size: 1});',
      'bm.to_mesh(me); bm.free();',
      "const ob = D.objects.new('Stairs', me); C.collection.objects.link(ob);",
    ].join('\n');
    const id = 'tx_e2e_bmesh';
    a.doc.texts[id] = { id, name: 'stairs.js', body: code, language: 'javascript' };
    a.hoverArea.editor.setText(id);
  });
  await page.evaluate(() => (window as any).app.run('text.run_script'));
  await page.waitForTimeout(200);
  const faces = await get(page, "(() => { const o = Object.values(app.doc.objects).find(o => o.name === 'Stairs'); return o ? app.doc.meshes[o.data].offsets.length - 1 : -1 })()");
  expect(faces).toBe(6);
  await page.mouse.move(10, box.y + 5);
  await page.evaluate(() => (window as any).app.undoStep());
  await page.waitForTimeout(150);
  expect(await get(page, "Object.values(app.doc.objects).some(o => o.name === 'Stairs')")).toBe(false);
  await expectNoErrors(errors);
});

test('operators from scripts: transforms with values and macro parts', async ({ page }) => {
  const errors = await openApp(page);
  await scriptingWorkspace(page);
  await consoleLine(page, "bpy.ops.object.select_all({action: 'DESELECT'}); D.objects['Cube'].select_set(true); C.view_layer.objects.active = D.objects['Cube']");
  await consoleLine(page, 'bpy.ops.transform.translate({value: [0, 0, 1]})');
  await consoleLine(page, 'bpy.ops.object.duplicate_move({TRANSFORM_OT_translate: {value: [3, 0, 0]}})');
  const pos = await get(page, "Object.values(app.doc.objects).filter(o => o.type === 'MESH').map(o => [o.name, ...o.location]).sort()");
  expect(pos).toEqual([
    ['Cube', 0, 0, 1],
    ['Cube.001', 3, 0, 1],
  ]);
  await expectNoErrors(errors);
});

test('a script menu opens with wm.call_menu and runs its operator', async ({ page }) => {
  const errors = await openApp(page);
  await scriptingWorkspace(page);
  await consoleLine(page, "class Quick extends bpy.types.Menu { static bl_idname = 'VIEW3D_MT_quick'; static bl_label = 'Quick'; draw() { this.layout.operator('mesh.primitive_cube_add', {text: 'Small Cube'}).size = 0.25 } }");
  await consoleLine(page, 'bpy.utils.register_class(Quick)');
  await consoleLine(page, "bpy.ops.wm.call_menu({name: 'VIEW3D_MT_quick'})");
  const item = page.locator('.menu .menu-item', { hasText: 'Small Cube' });
  await expect(item).toBeVisible();
  const before = (await get(page, 'Object.keys(app.doc.objects).length')) as number;
  await item.click();
  await page.waitForTimeout(150);
  expect(await get(page, 'Object.keys(app.doc.objects).length')).toBe(before + 1);
  await expectNoErrors(errors);
});

test('printing past the scrollback limit adds each line to the console once', async ({ page }) => {
  const errors = await openApp(page);
  await scriptingWorkspace(page);
  const lines = page.locator('.py-console .pc-line');
  await expect(lines.first()).toBeVisible();
  // count the line elements the console creates while a script prints 5100 lines (scrollback: 5000)
  await page.evaluate(() => {
    const w = window as any;
    w.__added = 0;
    new MutationObserver((records) => {
      for (const r of records) w.__added += r.addedNodes.length;
    }).observe(document.querySelector('.py-console .pc-lines')!, { childList: true });
  });
  await consoleLine(page, "for (let i = 0; i < 5100; i++) print('line ' + i)");
  await expect(lines.last()).toHaveText('line 5099');
  await expect(lines).toHaveCount(5000);
  // with a full scrollback the console used to redraw all 5000 lines for every printed line (minutes for a few thousand)
  expect(await page.evaluate(() => (window as any).__added)).toBeLessThan(5200);
  await consoleLine(page, "print('after')");
  await expect(lines.last()).toHaveText('after');
  await expect(lines).toHaveCount(5000);
  await expectNoErrors(errors);
});

test('lines typed while the Python runtime fails to load are reported once, not downloaded for each', async ({ page }) => {
  await openApp(page);
  let fetches = 0;
  await page.route(/cdn\.jsdelivr\.net\/pyodide/, async (route) => {
    fetches++;
    await new Promise((r) => setTimeout(r, 800));
    await route.abort();
  });
  await page.locator('.ws-tab', { hasText: 'Scripting' }).first().click();
  await page.waitForTimeout(300);
  const input = page.locator('.py-console').first().locator('.pc-input');
  await input.click();
  for (const line of ['a = 1', 'b = 2', 'print(a + b)']) {
    await input.fill(line);
    await input.press('Enter');
  }
  const lines = page.locator('.py-console .pc-line');
  await expect(lines.filter({ hasText: 'not run' })).toHaveCount(1);
  await page.waitForTimeout(1500);
  await expect(lines.filter({ hasText: 'Could not load the Python runtime' })).toHaveCount(1);
  expect(fetches).toBe(1);
  // the next line tries again
  await input.fill('a = 1');
  await input.press('Enter');
  await expect(lines.filter({ hasText: 'Could not load the Python runtime' })).toHaveCount(2);
});
