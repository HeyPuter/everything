import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Bytes of a project with a "Rig" collection (an empty "Root" parenting a mesh "Crate"). */
async function rigProject(page: Page, rename = 'Crate'): Promise<number[]> {
  return page.evaluate(async (rename) => {
    const { startupDocument, newCollection, newObject } = await import('/src/data/defaults.ts');
    const { encodeDocument } = await import('/src/io/native.ts');
    const d = startupDocument();
    const col = newCollection('Rig');
    const cube = Object.values(d.objects).find((o: any) => o.name === 'Cube') as any;
    cube.name = rename;
    for (const c of Object.values(d.collections) as any[]) c.objects = c.objects.filter((o: string) => o !== cube.id);
    const root = newObject('Root', 'EMPTY', null);
    d.objects[root.id] = root;
    d.object_order.push(root.id);
    cube.parent = root.id;
    col.objects.push(root.id, cube.id);
    d.collections[col.id] = col;
    d.collections[d.scene.collection].children.push(col.id);
    return Array.from(encodeDocument(d));
  }, rename);
}

/** Link "Rig" (instanced) through File > Link, picking the file from the computer. */
async function linkRig(page: Page) {
  const bytes = await rigProject(page);
  await page.evaluate(() => (window as any).app.run('wm.link'));
  const dlg = page.locator('.lb');
  await expect(dlg).toBeVisible();
  page.once('filechooser', (fc) => fc.setFiles({ name: 'props.p3d', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) }));
  await dlg.locator('.fb-side-item', { hasText: 'Choose File' }).click();
  await dlg.locator('.lb-row', { hasText: 'Collections' }).dblclick();
  await dlg.locator('.lb-row', { hasText: 'Rig' }).click();
  await dlg.locator('.lb-go').click();
  await expect(dlg).toHaveCount(0);
}

const names = (page: Page) =>
  page.evaluate(() =>
    (Object.values((window as any).app.doc.objects) as any[])
      .map((o) => `${o.name}${o.library ? '@L' : ''}${o.override_library ? '@O' : ''}`)
      .sort(),
  );

async function outlinerMode(page: Page, mode: string, open: string[] = []) {
  await page.evaluate(
    async ([mode, open]) => {
      const { currentOutliner } = await import('/src/editors/outliner/current.ts');
      const o = currentOutliner()!;
      o.setDisplayMode(mode as any);
      for (const k of open as string[]) o.setOpen(k, true);
      o.update();
    },
    [mode, open] as const,
  );
}

test('File > Link: linked data is read-only, overrides can move, Make Local and reload', async ({ page }) => {
  const errors = await openApp(page);
  await linkRig(page);
  expect(await names(page)).toEqual(['Camera', 'Crate@L', 'Cube', 'Light', 'Rig', 'Root@L']);
  // the instancing empty is selected and active; linked data refuses edits
  expect(await page.evaluate(() => (window as any).app.activeObject.instance_collection !== null)).toBe(true);
  const refused = await page.evaluate(() => {
    const a = (window as any).app;
    const crate = (Object.values(a.doc.objects) as any[]).find((o) => o.name === 'Crate');
    try {
      crate.location = [1, 2, 3];
      return false;
    } catch {
      return true;
    }
  });
  expect(refused).toBe(true);
  // Object > Library Override > Make
  await page.evaluate(() => {
    const a = (window as any).app;
    const empty = (Object.values(a.doc.objects) as any[]).find((o) => o.name === 'Rig');
    for (const o of Object.values(a.doc.objects) as any[]) o.select = false;
    empty.select = true;
    a.doc.scene.active_object = empty.id;
    a.run('object.make_override_library', {}, { invoke: false });
  });
  expect(await names(page)).toEqual(['Camera', 'Crate@L', 'Crate@O', 'Cube', 'Light', 'Root@L', 'Root@O']);
  const loc = await page.evaluate(() => {
    const a = (window as any).app;
    const root = (Object.values(a.doc.objects) as any[]).find((o) => o.name === 'Root' && o.override_library);
    for (const o of Object.values(a.doc.objects) as any[]) o.select = o === root;
    a.doc.scene.active_object = root.id;
    a.run('transform.translate', { value: [0, 2, 0] }, { invoke: false });
    return root.location;
  });
  expect(loc).toEqual([0, 2, 0]);
  // the mesh stays linked: Edit Mode is refused with an explanation
  await page.evaluate(() => {
    const a = (window as any).app;
    const crate = (Object.values(a.doc.objects) as any[]).find((o) => o.name === 'Crate' && o.override_library);
    a.doc.scene.active_object = crate.id;
    a.run('object.mode_set', { mode: 'EDIT' }, { invoke: false });
  });
  expect(await page.evaluate(() => (window as any).app.doc.mode)).toBe('OBJECT');
  expect(await page.evaluate(() => (window as any).app.reports.at(-1).message)).toContain('linked');
  // Make Local (objects, data and materials) turns the mesh local, after which Edit Mode works
  await page.evaluate(() => {
    const a = (window as any).app;
    const crate = (Object.values(a.doc.objects) as any[]).find((o) => o.name === 'Crate' && o.override_library);
    for (const o of Object.values(a.doc.objects) as any[]) o.select = o === crate;
    a.run('object.make_local', { type: 'SELECT_OBDATA_MATERIAL' }, { invoke: false });
    a.run('object.mode_set', { mode: 'EDIT' }, { invoke: false });
  });
  expect(await page.evaluate(() => (window as any).app.doc.mode)).toBe('EDIT');
  await page.evaluate(() => (window as any).app.run('object.mode_set', { mode: 'OBJECT' }, { invoke: false }));
  await expectNoErrors(errors);
});

test('Outliner: libraries in Data Blocks, Library Overrides, Data API and Video Sequencer modes', async ({ page }) => {
  const errors = await openApp(page);
  await linkRig(page);
  const libId = await page.evaluate(() => Object.keys((window as any).app.doc.libraries)[0]);
  await outlinerMode(page, 'BLENDER_FILE', [`lib:${libId}`, `lg:${libId}:objects`]);
  const ol = page.locator('.outliner').first();
  await expect(ol.locator('.ol-row', { hasText: 'props.p3d' })).toBeVisible();
  await expect(ol.locator('.ol-row', { hasText: 'Crate' }).locator('.lib-mark')).toBeVisible();
  // the library menu: reload keeps the data
  await ol.locator('.ol-row', { hasText: 'props.p3d' }).click({ button: 'right' });
  await expect(page.locator('.menu .menu-item', { hasText: 'Relocate' })).toBeVisible();
  await page.locator('.menu .menu-item', { hasText: 'Reload' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).app.reports.at(-1).message)).toContain('Reloaded');
  // overrides list what they change
  await page.evaluate(() => {
    const a = (window as any).app;
    const empty = (Object.values(a.doc.objects) as any[]).find((o) => o.name === 'Rig');
    a.doc.scene.active_object = empty.id;
    empty.select = true;
    a.run('object.make_override_library', {}, { invoke: false });
    const root = (Object.values(a.doc.objects) as any[]).find((o) => o.name === 'Root' && o.override_library);
    root.location = [1, 1, 1];
    a.changed('doc');
  });
  await outlinerMode(page, 'LIBRARY_OVERRIDES');
  await expect(ol.locator('.ol-row', { hasText: 'Location' })).toBeVisible();
  await ol.locator('.ol-row', { hasText: 'Location' }).click({ button: 'right' });
  await page.locator('.menu .menu-item', { hasText: 'Reset to Linked Value' }).click();
  expect(await page.evaluate(() => ((Object.values((window as any).app.doc.objects) as any[]).find((o) => o.name === 'Root' && o.override_library).location))).toEqual([0, 0, 0]);
  // Data API: values are shown and editable
  const cam = await page.evaluate(() => (Object.values((window as any).app.doc.objects) as any[]).find((o) => o.name === 'Camera').id);
  await outlinerMode(page, 'DATA_API', ['api:objects', `api:objects:${cam}`]);
  const nameRow = ol.locator('.ol-row', { hasText: 'Show name' });
  await expect(nameRow.locator('.ol-api-value')).toBeVisible();
  await nameRow.locator('.ol-api-value input[type=checkbox], .ol-api-value .checkbox').first().click();
  expect(await page.evaluate((id) => (window as any).app.doc.objects[id].show_name, cam)).toBe(true);
  // Video Sequencer mode lists strips
  await page.evaluate(() => (window as any).app.run('sequencer.effect_strip_add', { type: 'COLOR' }, { invoke: false }));
  await outlinerMode(page, 'SEQUENCE');
  await expect(ol.locator('.ol-row').first()).toBeVisible();
  await expectNoErrors(errors);
});
