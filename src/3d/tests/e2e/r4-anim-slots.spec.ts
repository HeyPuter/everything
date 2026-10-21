import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors, openHeaderMenu } from './helpers';

/** Key the cube and the camera into one action (two slots) and show an animation editor. */
async function setup(page: Page, editor: 'DOPESHEET' | 'GRAPH' | 'NLA', mode?: string) {
  await page.evaluate(
    async ([editor, mode]) => {
      const { shell } = await import('/src/ui/shell.ts');
      const { keyProperty } = await import('/src/anim/keyframes.ts');
      const app = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
      const objs = Object.values(app.doc.objects) as any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
      const cube = objs.find((o) => o.name === 'Cube');
      const cam = objs.find((o) => o.name === 'Camera');
      for (const [f, x] of [
        [1, 0],
        [11, 2],
        [21, 0],
      ]) {
        cube.location[0] = x;
        keyProperty(app.doc, cube, 'location', 0, f);
        cube.rotation_euler[2] = x;
        keyProperty(app.doc, cube, 'rotation_euler', 2, f);
      }
      cam.animation_data = { action: cube.animation_data.action, nla_tracks: [], drivers: [] };
      cam.location[1] = 5;
      keyProperty(app.doc, cam, 'location', 1, 1);
      app.activeObject = cube;
      app.pushUndo('Setup');
      const area = shell.screen.areas.find((a: { type: string }) => a.type === 'VIEW_3D');
      area.setType(editor);
      if (mode) area.editor.setMode(mode);
      app.changed('doc');
    },
    [editor, mode] as const,
  );
  await page.waitForTimeout(300);
}

const area = (page: Page, type: string) => page.locator(`.area[data-editor="${type}"]`).first();
const slotsOf = (page: Page) =>
  page.evaluate(() => {
    const app = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const act = app.doc.actions[app.activeObject.animation_data.action];
    return act.slots.map((s: { identifier: string }) => s.identifier);
  });

test('action editor: slot rows, slot selector, new slot and the Action menu', async ({ page }) => {
  const errors = await openApp(page);
  await setup(page, 'DOPESHEET', 'ACTION');
  const ds = area(page, 'DOPESHEET');
  await expect(ds.locator('.anim-ch-row.k-slot')).toHaveCount(2);
  await expect(ds.locator('.anim-ch-row.k-slot').first()).toContainText('Cube');
  const sel = ds.locator('[data-slot-selector="ds-slot"]');
  await expect(sel.locator('input')).toHaveValue('Cube');
  // browse lists both slots
  await sel.locator('.anim-id-browse').dispatchEvent('pointerdown');
  await expect(page.locator('.menu .menu-item', { hasText: 'Camera' })).toBeVisible();
  await page.keyboard.press('Escape');
  // New Slot gives the cube a fresh slot
  await sel.locator('[data-tip^="New Slot"]').click();
  expect(await slotsOf(page)).toEqual(['OBCube', 'OBCamera', 'OBCube.001']);
  await expect(sel.locator('input')).toHaveValue('Cube.001');
  // Action ▸ Separate Slots gives every slot its own action
  await openHeaderMenu(page, ds, 'Action');
  await page.locator('.menu .menu-item', { hasText: 'Separate Slots' }).click();
  const actions = await page.evaluate(() => Object.values((window as any).app.doc.actions).filter((a: any) => a.slots?.length).length); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(actions).toBe(3);
  await expectNoErrors(errors);
});

test('object properties: the Animation panel shows the slot', async ({ page }) => {
  const errors = await openApp(page);
  await setup(page, 'DOPESHEET');
  await page.evaluate(async () => {
    const { setPanelOpen } = await import('/src/ui/widgets.ts');
    setPanelOpen('ob-animation', true);
    (window as any).app.changed('ui'); // eslint-disable-line @typescript-eslint/no-explicit-any
  });
  const props = page.locator('.area[data-editor="PROPERTIES"]').first();
  await props.locator('.panel', { hasText: 'Animation' }).first().scrollIntoViewIfNeeded();
  const slot = props.locator('[data-slot-selector="ob-slot"]');
  await expect(slot.locator('input')).toHaveValue('Cube');
  await slot.locator('[data-tip^="Unassign Slot"]').click();
  await expect(slot.locator('.ids-new')).toBeVisible();
  const curves = await page.evaluate(async () => {
    const { objectCurves } = await import('/src/anim/slots.ts');
    const app = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    return objectCurves(app.doc, app.activeObject).length;
  });
  expect(curves).toBe(0);
  await expectNoErrors(errors);
});

test('graph editor: rotation curves show in degrees; dope sheet view toggles', async ({ page }) => {
  const errors = await openApp(page);
  await setup(page, 'GRAPH');
  const g = area(page, 'GRAPH');
  const disp = await page.evaluate(async () => {
    const { shell } = await import('/src/ui/shell.ts');
    const ed = shell.screen.areas.find((a: { type: string }) => a.type === 'GRAPH').editor;
    const r = ed.list.curves.find((c: { fc: { data_path: string } }) => c.fc.data_path === 'rotation_euler');
    return ed.toDisp(r.fc, Math.PI / 2);
  });
  expect(disp).toBeCloseTo(90, 5);
  await openHeaderMenu(page, g, 'View');
  await page.locator('.menu .menu-item', { hasText: /^Channels/ }).click();
  await expect(g.locator('.anim-ch')).toBeHidden();
  await page.evaluate(async () => {
    const { shell } = await import('/src/ui/shell.ts');
    shell.screen.areas.find((a: { type: string }) => a.type === 'GRAPH').setType('DOPESHEET');
  });
  const ds = area(page, 'DOPESHEET');
  await openHeaderMenu(page, ds, 'View');
  await page.locator('.menu .menu-item', { hasText: 'Show Extremes' }).click();
  expect(
    await page.evaluate(async () => {
      const { shell } = await import('/src/ui/shell.ts');
      return shell.screen.areas.find((a: { type: string }) => a.type === 'DOPESHEET').editor.showExtremes;
    }),
  ).toBe(true);
  await expectNoErrors(errors);
});

test('NLA: strip modifiers tab adds a modifier to the active strip', async ({ page }) => {
  const errors = await openApp(page);
  await setup(page, 'NLA');
  await page.evaluate(async () => {
    const app = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    app.run('action.push_down');
    const { shell } = await import('/src/ui/shell.ts');
    const ed = shell.screen.areas.find((a: { type: string }) => a.type === 'NLA').editor;
    const strip = app.activeObject.animation_data.nla_tracks[0].strips[0];
    strip.select = true;
    ed.activeStrip = strip;
    ed.showSidebar = true;
    ed.sidebarTab = 'modifiers';
    ed.refresh();
    app.changed('ui');
  });
  const nla = area(page, 'NLA');
  await nla.locator('.anim-sb-addbtn').dispatchEvent('pointerdown');
  await page.locator('.menu .menu-item', { hasText: 'Generator' }).click();
  const mods = await page.evaluate(() => (window as any).app.activeObject.animation_data.nla_tracks[0].strips[0].modifiers.map((m: { type: string }) => m.type)); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(mods).toEqual(['GENERATOR']);
  await expect(nla.locator('.anim-mod')).toHaveCount(1);
  await expectNoErrors(errors);
});

test('frames: Alt + wheel steps the current frame', async ({ page }) => {
  const errors = await openApp(page);
  const box = (await page.locator('.view3d').first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const before = await page.evaluate(() => (window as any).app.doc.scene.frame_current); // eslint-disable-line @typescript-eslint/no-explicit-any
  await page.keyboard.down('Alt');
  await page.mouse.wheel(0, 100);
  await page.mouse.wheel(0, 100);
  await page.mouse.wheel(0, -100);
  await page.keyboard.up('Alt');
  await expect.poll(() => page.evaluate(() => (window as any).app.doc.scene.frame_current)).toBe(before + 1); // eslint-disable-line @typescript-eslint/no-explicit-any
  await expectNoErrors(errors);
});
