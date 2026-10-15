import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

/** Key the cube's X location and turn the 3D view into the given animation editor. */
async function setup(page: Page, editor: 'GRAPH' | 'DOPESHEET' | 'NLA', vals = [0, 1, 3, 2, 5, 4, 6, 2, 0], sel = [2, 3, 4, 5, 6]) {
  await page.evaluate(
    async ([editor, vals, sel]) => {
      const { shell } = await import('/src/ui/shell.ts');
      const { keyProperty } = await import('/src/anim/keyframes.ts');
      const app = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
      const ob = app.activeObject;
      (vals as number[]).forEach((v, i) => {
        ob.location[0] = v;
        keyProperty(app.doc, ob, 'location', 0, 1 + i * 5);
      });
      const fc = app.doc.actions[ob.animation_data.action].fcurves[0];
      fc.keyframe_points.forEach((k: any, i: number) => { // eslint-disable-line @typescript-eslint/no-explicit-any
        const s = (sel as number[]).includes(i);
        k.select_control_point = s;
        k.select_left_handle = s;
        k.select_right_handle = s;
      });
      app.pushUndo('Setup');
      shell.screen.areas.find((a: { type: string }) => a.type === 'VIEW_3D').setType(editor);
      app.changed('doc');
    },
    [editor, vals, sel] as const,
  );
  await page.waitForTimeout(300);
  const box = (await page.locator('.anim-main canvas').first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  return box;
}

const keyValues = (page: Page) =>
  page.evaluate(() => {
    const app = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const ob = app.activeObject;
    return app.doc.actions[ob.animation_data.action].fcurves[0].keyframe_points.map((k: { co: number[] }) => Math.round(k.co[1] * 1000) / 1000);
  });

test('graph editor: blend slider from the Key menu, then adjust it from the redo panel', async ({ page }) => {
  const errors = await openApp(page);
  const box = await setup(page, 'GRAPH');
  await page.locator('.hdr-menu', { hasText: 'Key' }).click();
  await page.locator('.menu-item', { hasText: /^Blend/ }).first().hover();
  await page.locator('.menu-item', { hasText: 'Blend to Neighbor' }).click();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 4 });
  await page.mouse.down();
  await page.mouse.up();
  const after = await keyValues(page);
  expect(after).not.toEqual([0, 1, 3, 2, 5, 4, 6, 2, 0]);
  expect(await page.evaluate(() => (window as any).app.lastOp?.idname)).toBe('graph.blend_to_neighbor'); // eslint-disable-line @typescript-eslint/no-explicit-any
  // Adjust Last Operation re-runs on the previous state
  await page.evaluate(() => (window as any).app.redoLast({ factor: 0.5 })); // eslint-disable-line @typescript-eslint/no-explicit-any
  await page.waitForTimeout(100);
  expect(await keyValues(page)).toEqual([0, 1, 2.5, 2, 3.5, 3, 4, 2, 0]);
  await expectNoErrors(errors);
});

test('graph editor: smoothing, density and blend shortcuts', async ({ page }) => {
  const errors = await openApp(page);
  await setup(page, 'GRAPH');
  await page.keyboard.press('Alt+S');
  await expect(page.locator('.menu-item', { hasText: 'Butterworth Smooth' })).toBeVisible();
  await page.locator('.menu-item', { hasText: 'Smooth (Legacy)' }).click();
  expect((await keyValues(page)).slice(2, 7)).toEqual([3, 3.5, 3.833, 4.75, 6]);
  await page.keyboard.press('Alt+D');
  await expect(page.locator('.menu-item', { hasText: 'Scale from Neighbor' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Shift+Alt+O');
  expect((await keyValues(page)).length).toBe(25);
  await expectNoErrors(errors);
});

test('graph editor: circle select, select key handles and euler filter entries', async ({ page }) => {
  const errors = await openApp(page);
  const box = await setup(page, 'GRAPH', [0, 1, 3, 2, 5, 4, 6, 2, 0], []);
  await page.keyboard.press('Home');
  await page.keyboard.press('C');
  await page.mouse.move(box.x + 5, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 5, box.y + box.height / 2, { steps: 30 });
  await page.mouse.up();
  await page.mouse.click(box.x + 20, box.y + 40, { button: 'right' });
  const selected = await page.evaluate(() => {
    const app = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const ob = app.activeObject;
    return app.doc.actions[ob.animation_data.action].fcurves[0].keyframe_points.filter((k: { select_control_point: boolean }) => k.select_control_point).length;
  });
  expect(selected).toBeGreaterThan(0);
  await page.locator('.hdr-menu', { hasText: 'Select' }).click();
  await expect(page.locator('.menu-item', { hasText: 'Select Handles' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.locator('.hdr-menu', { hasText: 'Channel' }).click();
  await expect(page.locator('.menu-item', { hasText: 'Discontinuity (Euler) Filter' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expectNoErrors(errors);
});

test('markers: add, select, rename, camera bind and delete', async ({ page }) => {
  const errors = await openApp(page);
  await setup(page, 'DOPESHEET');
  await page.keyboard.press('M');
  expect(await page.evaluate(() => (window as any).app.doc.scene.timeline_markers.map((m: { name: string }) => m.name))).toEqual(['F_01']); // eslint-disable-line @typescript-eslint/no-explicit-any
  // jump and add another, then bind the camera there
  await page.evaluate(() => {
    const app = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    app.setFrame(20);
  });
  await page.keyboard.press('Control+B');
  const ms = await page.evaluate(() => (window as any).app.doc.scene.timeline_markers.map((m: { frame: number; camera?: string }) => [m.frame, !!m.camera])); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(ms).toEqual([
    [1, false],
    [20, true],
  ]);
  // marker row: select all with A, delete with X
  const box = (await page.locator('.anim-main canvas').first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 8);
  await page.keyboard.press('A');
  expect(await page.evaluate(() => (window as any).app.doc.scene.timeline_markers.every((m: { select: boolean }) => m.select))).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any
  await page.locator('.hdr-menu', { hasText: 'Marker' }).first().click();
  await expect(page.locator('.menu-item', { hasText: 'Bind Camera to Markers' })).toBeVisible();
  await page.locator('.menu-item', { hasText: 'Delete Marker' }).click();
  expect(await page.evaluate(() => (window as any).app.doc.scene.timeline_markers.length)).toBe(0); // eslint-disable-line @typescript-eslint/no-explicit-any
  await expectNoErrors(errors);
});

test('channels: reorder, editability toggle and preview range', async ({ page }) => {
  const errors = await openApp(page);
  await setup(page, 'GRAPH');
  await page.evaluate(async () => {
    const { keyProperty } = await import('/src/anim/keyframes.ts');
    const app = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    keyProperty(app.doc, app.activeObject, 'scale', -1, 1);
    const act = app.doc.actions[app.activeObject.animation_data.action];
    act.fcurves.forEach((f: { select: boolean; data_path: string; array_index: number }) => (f.select = f.data_path === 'scale' && f.array_index === 2));
    app.pushUndo('more');
    app.changed('doc');
  });
  await page.waitForTimeout(200);
  const ch = (await page.locator('.anim-ch-rows').boundingBox())!;
  await page.mouse.move(ch.x + 40, ch.y + 10);
  await page.keyboard.press('Shift+PageUp');
  const order = await page.evaluate(() => {
    const app = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    return app.doc.actions[app.activeObject.animation_data.action].fcurves.filter((f: { group?: string }) => f.group).map((f: { data_path: string; array_index: number }) => `${f.data_path}${f.array_index}`);
  });
  expect(order.indexOf('scale2')).toBeLessThan(order.indexOf('scale0'));
  await page.keyboard.press('Tab');
  expect(
    await page.evaluate(() => {
      const app = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
      return app.doc.actions[app.activeObject.animation_data.action].fcurves.find((f: { select: boolean }) => f.select).lock;
    }),
  ).toBe(true);
  // P + drag sets the preview range
  const box = (await page.locator('.anim-main canvas').first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press('P');
  await page.mouse.move(box.x + 100, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + 300, box.y + 100, { steps: 3 });
  await page.mouse.up();
  const s = await page.evaluate(() => {
    const sc = (window as any).app.doc.scene; // eslint-disable-line @typescript-eslint/no-explicit-any
    return [sc.use_preview_range, sc.frame_preview_start < sc.frame_preview_end];
  });
  expect(s).toEqual([true, true]);
  await page.keyboard.press('Alt+P');
  expect(await page.evaluate(() => (window as any).app.doc.scene.use_preview_range)).toBe(false); // eslint-disable-line @typescript-eslint/no-explicit-any
  await expectNoErrors(errors);
});
