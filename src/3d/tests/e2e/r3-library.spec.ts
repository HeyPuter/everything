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

test('Linking from a recent project follows its saved changes; dropped project files offer Open / Link / Append', async ({ page }) => {
  const errors = await openApp(page);
  const v1 = await rigProject(page, 'Crate');
  await page.evaluate(async (bytes) => {
    const { recordRecent } = await import('/src/io/session.ts');
    await recordRecent('props.p3d', new Uint8Array(bytes));
  }, v1);
  await page.evaluate(() => (window as any).app.run('wm.link'));
  const dlg = page.locator('.lb');
  await dlg.locator('.fb-side-item', { hasText: 'Recent Projects' }).click();
  // the keyboard walks the browser: Down picks the first row, Enter opens it
  await dlg.locator('.lb-row', { hasText: 'props.p3d' }).waitFor();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await dlg.locator('.lb-row', { hasText: 'Objects' }).dblclick();
  await dlg.locator('.lb-row', { hasText: 'Crate' }).click();
  // Backspace goes up a level and back keeps the pick
  await page.keyboard.press('Backspace');
  await expect(dlg.locator('.lb-row', { hasText: 'Collections' })).toBeVisible();
  await expect(dlg.locator('.lb-count')).toHaveText('1');
  await dlg.locator('.lb-go').click();
  await expect(dlg).toHaveCount(0);
  expect(await names(page)).toContain('Crate@L');
  expect(await page.evaluate(() => (window as any).app.activeObject.name)).toBe('Crate');
  // the library project is saved again with the crate moved
  const v2 = await page.evaluate(async () => {
    const { decodeDocument, encodeDocument } = await import('/src/io/native.ts');
    const { recentBytes, recordRecent } = await import('/src/io/session.ts');
    const d = decodeDocument((await recentBytes('props.p3d'))!).doc;
    (Object.values(d.objects).find((o: any) => o.name === 'Crate') as any).location = [0, 0, 3];
    await recordRecent('props.p3d', encodeDocument(d));
    return true;
  });
  expect(v2).toBe(true);
  await page.evaluate(() => (window as any).app.run('wm.lib_reload', {}, { invoke: false }));
  await expect.poll(() => page.evaluate(() => (window as any).app.activeObject.location[2])).toBe(3);
  // undo goes back to before the reload
  await page.evaluate(() => (window as any).app.undoStep());
  expect(await page.evaluate(() => (window as any).app.activeObject?.location[2] ?? 0)).toBe(0);
  // a project file dropped onto the window
  const bytes = v1;
  await page.evaluate(async (bytes) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], 'dropped.p3d'));
    const target = document.querySelector('.view3d')!;
    const r = target.getBoundingClientRect();
    const at = { clientX: r.left + 200, clientY: r.top + 200, dataTransfer: dt, bubbles: true, cancelable: true };
    target.dispatchEvent(new DragEvent('dragover', at));
    target.dispatchEvent(new DragEvent('drop', at));
  }, bytes);
  await expect(page.locator('.menu .menu-item', { hasText: 'Append…' })).toBeVisible();
  await page.locator('.menu .menu-item', { hasText: 'Append…' }).click();
  await expect(page.locator('.lb .lb-crumb', { hasText: 'dropped.p3d' })).toBeVisible();
  await page.locator('.lb .lb-row', { hasText: 'Objects' }).dblclick();
  await page.locator('.lb .lb-row', { hasText: 'Root' }).click();
  await page.locator('.lb .lb-go').click();
  expect(await names(page)).toContain('Root');
  await expectNoErrors(errors);
});

const olRow = (page: Page, name: string) => page.locator('.outliner .ol-row', { has: page.locator('.ol-name', { hasText: new RegExp(`^${name}$`) }) }).first();

test('Outliner operations: modifier drag, remap users, hierarchy delete, keying sets and drivers from Data API rows', async ({ page }) => {
  const errors = await openApp(page);
  // two modifiers on the cube, shown in the outliner
  await page.evaluate(() => {
    const a = (window as any).app;
    a.run('object.modifier_add', { type: 'SUBSURF' }, { invoke: false });
    a.run('object.modifier_add', { type: 'BEVEL' }, { invoke: false });
  });
  await page.evaluate(async () => {
    const { currentOutliner } = await import('/src/editors/outliner/current.ts');
    const o = currentOutliner()!;
    const cube = (Object.values((window as any).app.doc.objects) as any[]).find((x) => x.name === 'Cube');
    o.setOpen(`o:${cube.id}`, true);
    o.setOpen(`ms:${cube.id}`, true);
    o.update();
  });
  const mods = () => page.evaluate(() => (window as any).app.activeObject.modifiers.map((m: any) => m.name));
  expect(await mods()).toEqual(['Subdivision Surface', 'Bevel']);
  // drag Bevel onto the top half of Subdivision: it moves first
  await olRow(page, 'Bevel').locator('.ol-item').dragTo(olRow(page, 'Subdivision Surface'), { targetPosition: { x: 60, y: 3 } });
  expect(await mods()).toEqual(['Bevel', 'Subdivision Surface']);
  // a modifier dropped on another object: a copy goes there
  await page.evaluate(() => {
    const a = (window as any).app;
    const obs = Object.values(a.doc.objects) as any[];
    const cube = obs.find((o) => o.name === 'Cube');
    const cam = obs.find((o) => o.name === 'Camera');
    a.run('outliner.datastack_drop', { kind: 'modifier', object: cube.id, item: cube.modifiers[0].id, target_object: cam.id }, { invoke: false });
  });
  expect(await page.evaluate(() => (Object.values((window as any).app.doc.objects) as any[]).find((o) => o.name === 'Camera').modifiers.map((m: any) => m.name))).toEqual(['Bevel']);
  // remap users: the cube's mesh users switch to a new mesh
  const remapped = await page.evaluate(() => {
    const a = (window as any).app;
    const cube = a.activeObject;
    const me = a.doc.meshes[cube.data];
    a.run('mesh.primitive_uv_sphere_add', {}, { invoke: false });
    const sphere = a.activeObject;
    a.run('outliner.id_remap', { id_type: 'meshes', old_id: me.id, new_id: sphere.data }, { invoke: false });
    return cube.data === sphere.data || a.doc.objects[cube.id].data === sphere.data;
  });
  expect(remapped).toBe(true);
  // delete a collection hierarchy with what is inside
  await page.evaluate(async () => {
    const a = (window as any).app;
    const { currentOutliner } = await import('/src/editors/outliner/current.ts');
    const o = currentOutliner()!;
    const col = (Object.values(a.doc.collections) as any[]).find((c) => c.name === 'Collection');
    o.update();
    const r = o.rows.find((x: any) => x.kind === 'collection' && x.id === col.id);
    o.clickRow(r);
    a.run('outliner.collection_hierarchy_delete', {}, { invoke: false });
  });
  expect(await page.evaluate(() => Object.keys((window as any).app.doc.objects).length)).toBe(0);
  // Data API: K adds the selected property to a keying set, Ctrl D adds a driver
  await page.evaluate(() => (window as any).app.run('object.empty_add', {}, { invoke: false }));
  const ob = await page.evaluate(() => (window as any).app.activeObject.id);
  await page.evaluate(async (ob) => {
    const { currentOutliner } = await import('/src/editors/outliner/current.ts');
    const o = currentOutliner()!;
    o.setDisplayMode('DATA_API');
    for (const k of ['api:objects', `api:objects:${ob}`, `api:objects:${ob}/location`]) o.setOpen(k, true);
    o.update();
  }, ob);
  await olRow(page, '2').click();
  const b = (await page.locator('.outliner .ol-list').first().boundingBox())!;
  await page.mouse.move(b.x + 40, b.y + b.height - 8);
  await page.keyboard.press('k');
  expect(await page.evaluate(() => (window as any).app.doc.scene.keying_sets?.[0]?.paths.map((p: any) => `${p.data_path}[${p.index}]`))).toEqual(['location[2]']);
  await page.keyboard.press('Control+d');
  expect(await page.evaluate(() => (window as any).app.activeObject.animation_data?.drivers.map((d: any) => `${d.data_path}[${d.array_index}]`))).toEqual(['location[2]']);
  await expectNoErrors(errors);
});

test('Relocate a library to another file, pack it into the project', async ({ page }) => {
  const errors = await openApp(page);
  const v1 = await rigProject(page, 'Crate');
  const v2 = await rigProject(page, 'Crate');
  await page.evaluate(
    async ([a, b]) => {
      const { recordRecent } = await import('/src/io/session.ts');
      const { decodeDocument, encodeDocument } = await import('/src/io/native.ts');
      await recordRecent('props.p3d', new Uint8Array(a));
      // another file whose crate is somewhere else (different ids)
      const d = decodeDocument(new Uint8Array(b)).doc;
      (Object.values(d.objects).find((o: any) => o.name === 'Crate') as any).location = [5, 0, 0];
      await recordRecent('props_v2.p3d', encodeDocument(d));
    },
    [v1, v2],
  );
  await page.evaluate(() => (window as any).app.run('wm.link'));
  const dlg = page.locator('.lb');
  await dlg.locator('.fb-side-item', { hasText: 'Recent Projects' }).click();
  await dlg.locator('.lb-row', { hasText: /^props\.p3d/ }).dblclick();
  await dlg.locator('.lb-row', { hasText: 'Objects' }).dblclick();
  await dlg.locator('.lb-row', { hasText: 'Crate' }).click();
  await dlg.locator('.lb-go').click();
  await expect(dlg).toHaveCount(0);
  // Outliner > Data Blocks > library menu > Relocate…
  await outlinerMode(page, 'BLENDER_FILE');
  const ol = page.locator('.outliner').first();
  await ol.locator('.ol-row', { hasText: 'props.p3d' }).click({ button: 'right' });
  await page.locator('.menu .menu-item', { hasText: 'Relocate' }).click();
  await expect(dlg).toBeVisible();
  await dlg.locator('.fb-side-item', { hasText: 'Recent Projects' }).click();
  await dlg.locator('.lb-row', { hasText: 'props_v2.p3d' }).dblclick();
  await expect(dlg).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (Object.values((window as any).app.doc.objects) as any[]).find((o) => o.name === 'Crate').location[0])).toBe(5);
  expect(await page.evaluate(() => Object.values((window as any).app.doc.libraries).map((l: any) => l.name))).toEqual(['props_v2.p3d']);
  // File > External Data > Pack Linked Libraries stores the file inside the project
  await page.evaluate(() => (window as any).app.run('file.pack_libraries', {}, { invoke: false }));
  await expect.poll(() => page.evaluate(() => (Object.values((window as any).app.doc.libraries) as any[])[0].packed_file?.length ?? 0)).toBeGreaterThan(0);
  await expectNoErrors(errors);
});
