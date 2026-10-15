// Modifier stack: Add Modifier menu placement and panels/operators of the newer modifier types.
import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

// reads after flushing pending changes (evaluation is otherwise deferred to the next frame)
const get = (page: Page, expr: string) => page.evaluate(`(() => { const app = window.app; app.flushPending(); return ${expr}; })()`);
const run = (page: Page, op: string, props: Record<string, unknown> = {}) => page.evaluate(([o, p]) => (window as any).app.run(o, p, { invoke: false }), [op, props] as const); // eslint-disable-line @typescript-eslint/no-explicit-any
const item = (page: Page, text: string) => page.locator('.menu-item', { hasText: new RegExp(`^\\s*${text}\\s*$`) });

async function modifierTab(page: Page) {
  await page.locator('.rail-tab[data-tab="MODIFIER"]').first().click();
  await expect(page.locator('.add-mod')).toBeVisible();
}

test('Add Modifier lists the new types in their categories', async ({ page }) => {
  const errors = await openApp(page);
  await modifierTab(page);
  const expected: Record<string, string[]> = {
    Edit: ['Data Transfer', 'Mesh Cache', 'UV Project', 'UV Warp', 'Vertex Weight Edit', 'Vertex Weight Mix', 'Vertex Weight Proximity'],
    Generate: ['Multiresolution', 'Skin'],
    Deform: ['Laplacian Deform', 'Mesh Deform', 'Smooth Corrective', 'Surface Deform'],
    Normals: ['Normal Edit'],
    Physics: ['Collision', 'Explode', 'Ocean', 'Particle Instance'],
  };
  for (const [cat, names] of Object.entries(expected)) {
    await page.locator('.add-mod').dispatchEvent('pointerdown');
    await item(page, cat).first().hover();
    for (const n of names) await expect(item(page, n).first()).toBeVisible();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
  }
  // adding from the menu creates the modifier and its panel
  await page.locator('.add-mod').dispatchEvent('pointerdown');
  await item(page, 'Edit').first().hover();
  await item(page, 'Vertex Weight Edit').first().click();
  expect(await get(page, `app.activeObject.modifiers.map((m) => m.type)`)).toEqual(['VERTEX_WEIGHT_EDIT']);
  await expect(page.locator('.panel.modifier .panel-header', { hasText: 'Falloff' })).toBeVisible();
  await expectNoErrors(errors);
});

test('vertex weight edit changes the evaluated weights', async ({ page }) => {
  const errors = await openApp(page);
  await run(page, 'object.vertex_group_add');
  await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const me = a.doc.meshes[a.activeObject.data];
    me.weights = [Float32Array.from({ length: me.positions.length / 3 }, (_, i: number) => (i % 2 ? 0.5 : 0))];
    a.pushUndo('weights');
  });
  await run(page, 'object.modifier_add', { type: 'VERTEX_WEIGHT_EDIT' });
  await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    Object.assign(a.activeObject.modifiers[0], { vertex_group: 'Group', falloff_type: 'SHARP', use_add: true, default_weight: 0.6, add_threshold: 0.1 });
    a.changed('doc');
  });
  const w = (await get(page, `Array.from(app.graph.get(app.activeObject.id).mesh.weights[0])`)) as number[];
  expect(w[1]).toBeCloseTo(0.25, 4);
  expect(w[0]).toBeCloseTo(0.36, 4);
  await expectNoErrors(errors);
});

test('mesh deform binds to a cage from the panel', async ({ page }) => {
  const errors = await openApp(page);
  const cube = (await get(page, 'app.activeObject.id')) as string;
  await run(page, 'mesh.primitive_cube_add', { size: 3, location: [0, 0, 0] });
  const cage = (await get(page, 'app.activeObject.id')) as string;
  await page.evaluate(([c]) => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    for (const o of Object.values(a.doc.objects) as { id: string; select: boolean }[]) o.select = o.id === c;
    a.doc.scene.active_object = c;
    a.changed('select');
  }, [cube]);
  await run(page, 'object.modifier_add', { type: 'MESH_DEFORM' });
  await page.evaluate(([c]) => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    a.activeObject.modifiers[0].object = c;
    a.changed('doc');
  }, [cage]);
  await modifierTab(page);
  await page.locator('.panel.modifier button', { hasText: /^Bind$/ }).click();
  await expect(page.locator('.panel.modifier button', { hasText: /^Unbind$/ })).toBeVisible();
  await page.evaluate(([c]) => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    a.doc.objects[c].scale = [2, 2, 2];
    a.changed('doc');
  }, [cage]);
  const maxX = (await get(page, `Math.max(...Array.from(app.graph.get(app.activeObject.id).mesh.positions).filter((_, i) => i % 3 === 0))`)) as number;
  expect(maxX).toBeCloseTo(2, 3);
  await expectNoErrors(errors);
});

test('multires subdivides from the panel and skin creates an armature', async ({ page }) => {
  const errors = await openApp(page);
  await run(page, 'object.modifier_add', { type: 'MULTIRES' });
  await modifierTab(page);
  await page.locator('.panel.modifier button', { hasText: /^Subdivide$/ }).click();
  await page.locator('.panel.modifier button', { hasText: /^Subdivide$/ }).click();
  expect(await get(page, `app.activeObject.modifiers[0].total_levels`)).toBe(2);
  expect(await get(page, `app.graph.get(app.activeObject.id).mesh.positions.length / 3`)).toBe(98);
  await page.locator('.panel.modifier button', { hasText: /^Unsubdivide$/ }).click();
  // the cube is not a subdivided mesh: nothing to rebuild
  expect(await get(page, `app.activeObject.modifiers[0].total_levels`)).toBe(2);
  await run(page, 'object.modifier_remove', { modifier: (await get(page, 'app.activeObject.modifiers[0].id')) as string });

  await run(page, 'object.modifier_add', { type: 'SKIN' });
  expect(await get(page, `app.doc.meshes[app.activeObject.data].skin_vertices.length`)).toBe(32);
  await page.locator('.panel.modifier button', { hasText: /^Create Armature$/ }).click();
  expect(await get(page, `Object.values(app.doc.objects).filter((o) => o.type === 'ARMATURE').length`)).toBe(1);
  expect(await get(page, `app.activeObject.modifiers.map((m) => m.type)`)).toEqual(['ARMATURE', 'SKIN']);
  await expectNoErrors(errors);
});

test('sculpting a multires mesh edits its sculpt level', async ({ page }) => {
  const errors = await openApp(page);
  await run(page, 'object.modifier_add', { type: 'MULTIRES' });
  const id = (await get(page, 'app.activeObject.modifiers[0].id')) as string;
  await run(page, 'object.multires_subdivide', { modifier: id });
  await run(page, 'object.multires_subdivide', { modifier: id });
  await run(page, 'object.mode_set', { mode: 'SCULPT' });
  expect(await get(page, `app.doc.mode`)).toBe('SCULPT');
  expect(await get(page, `app.doc.meshes[app.activeObject.data].positions.length / 3`)).toBe(98);
  // a stand-in for a brush stroke: lift every vertex of the sculpt level
  await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const me = a.doc.meshes[a.activeObject.data];
    me.positions = Float32Array.from(me.positions, (x: number, i: number) => (i % 3 === 2 ? x + 0.5 : x));
    a.changed('doc');
  });
  await run(page, 'object.mode_set', { mode: 'OBJECT' });
  expect(await get(page, `app.doc.meshes[app.activeObject.data].positions.length / 3`)).toBe(8);
  const zs = (await get(page, `Array.from(app.graph.get(app.activeObject.id).mesh.positions).filter((_, i) => i % 3 === 2)`)) as number[];
  expect(Math.max(...zs)).toBeGreaterThan(1.3);
  expect(Math.min(...zs)).toBeGreaterThan(-0.9);
  await expectNoErrors(errors);
});

test('mesh cache loads an MDD file from disk and data transfer creates its layers', async ({ page }) => {
  const errors = await openApp(page);
  // a 3-frame MDD for the 8-vertex cube: every frame lifts the cube by one unit
  const P = [-1, -1, -1, -1, -1, 1, -1, 1, -1, -1, 1, 1, 1, -1, -1, 1, -1, 1, 1, 1, -1, 1, 1, 1];
  const frames = 3,
    points = 8;
  const buf = Buffer.alloc(8 + frames * 4 + frames * points * 12);
  buf.writeInt32BE(frames, 0);
  buf.writeInt32BE(points, 4);
  for (let f = 0; f < frames; f++) buf.writeFloatBE(f / 24, 8 + f * 4);
  let o = 8 + frames * 4;
  for (let f = 0; f < frames; f++) for (let i = 0; i < points * 3; i++, o += 4) buf.writeFloatBE(P[i] + (i % 3 === 2 ? f : 0), o);
  await run(page, 'object.modifier_add', { type: 'MESH_CACHE' });
  await modifierTab(page);
  const chooser = page.waitForEvent('filechooser');
  await page.locator('.panel.modifier button', { hasText: 'Open…' }).click();
  await (await chooser).setFiles({ name: 'lift.mdd', mimeType: 'application/octet-stream', buffer: buf });
  await expect(page.locator('.panel.modifier .mod-note', { hasText: '3 frames, 8 points' })).toBeVisible();
  await page.evaluate(() => (window as any).app.setFrame(2)); // eslint-disable-line @typescript-eslint/no-explicit-any
  const zs = (await get(page, `Array.from(app.graph.get(app.activeObject.id).mesh.positions).filter((_, i) => i % 3 === 2)`)) as number[];
  expect(Math.max(...zs)).toBeCloseTo(3, 4);

  // data transfer: a source with a vertex group the target lacks
  await run(page, 'object.modifier_remove', { modifier: (await get(page, 'app.activeObject.modifiers[0].id')) as string });
  const target = (await get(page, 'app.activeObject.id')) as string;
  await run(page, 'mesh.primitive_plane_add', { size: 4, location: [0, 0, 3] });
  await run(page, 'object.vertex_group_add');
  const source = (await get(page, 'app.activeObject.id')) as string;
  await page.evaluate(([t]) => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    for (const ob of Object.values(a.doc.objects) as { id: string; select: boolean }[]) ob.select = ob.id === t;
    a.doc.scene.active_object = t;
    a.changed('select');
  }, [target]);
  await run(page, 'object.modifier_add', { type: 'DATA_TRANSFER' });
  await page.evaluate(([s]) => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    Object.assign(a.activeObject.modifiers[0], { object: s, use_vert_data: true, data_types_verts: ['VGROUP_WEIGHTS'] });
    a.changed('doc');
  }, [source]);
  await page.locator('.panel.modifier button', { hasText: 'Generate Data Layers' }).click();
  expect(await get(page, `app.doc.meshes[app.activeObject.data].vertex_groups.map((g) => g.name)`)).toEqual(['Group']);
  await expectNoErrors(errors);
});
