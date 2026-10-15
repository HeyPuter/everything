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
