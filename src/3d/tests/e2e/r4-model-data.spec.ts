// Object Data tab of meshes and lattices: Attributes list (add dialog), UV Maps list, Geometry Data
// buttons, Remesh panel modes with the quad remesher dialog, lattice interpolation / vertex groups.
import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const mesh = (page: Page) => page.evaluate(() => {
  const a = (window as Any).app;
  const me = a.doc.meshes[a.activeObject.data];
  return { attrs: (me.attributes ?? []).map((x: Any) => `${x.name}:${x.domain}:${x.data_type}`), uv: [me.uv_map_name, ...(me.uv_layers_extra ?? []).map((u: Any) => u.name)], faces: me.offsets.length - 1, nv: me.positions.length / 3 };
});
const openPanel = async (page: Page, id: string) => {
  const p = page.locator(`[data-panel="${id}"]`).first();
  if (!(await p.evaluate((el) => el.classList.contains('open')))) await p.locator('.panel-header').first().click();
  return p;
};

test('mesh data tab: attributes, UV maps, geometry data, quad remesh', async ({ page }) => {
  const errors = await openApp(page);
  await page.locator('.rail-tab[data-tab="DATA"]').first().click();
  // Attributes: + opens the dialog, OK adds the attribute
  const attrs = await openPanel(page, 'me-attributes');
  await expect(attrs.locator('.uilist .ul-row', { hasText: 'position' })).toBeVisible();
  await attrs.locator('.ul-side .icon-btn[data-tip="Add"]').click();
  const dlg = page.locator('.op-dialog[data-op-dialog="geometry.attribute_add"]');
  await expect(dlg).toBeVisible();
  await dlg.locator('.op-dialog-buttons .btn').click();
  expect((await mesh(page)).attrs).toEqual(['Attribute:POINT:FLOAT']);
  await expect(attrs.locator('.uilist .ul-row', { hasText: 'Attribute' })).toBeVisible();
  // UV Maps: + adds a copy and makes it active, - removes it again
  const uv = await openPanel(page, 'me-uvmaps');
  await uv.locator('.ul-side .icon-btn[data-tip="Add"]').click();
  expect((await mesh(page)).uv).toEqual(['UVMap.001', 'UVMap']);
  await expect(uv.locator('.ul-row')).toHaveCount(2);
  await uv.locator('.ul-row', { hasText: /^UVMap$/ }).click();
  expect((await mesh(page)).uv[0]).toBe('UVMap');
  // Geometry Data: skin data can be added and cleared
  const gd = await openPanel(page, 'me-geodata');
  await gd.locator('button', { hasText: 'Add Skin Data' }).click();
  await expect(gd.locator('button', { hasText: 'Clear Skin Data' })).toBeVisible();
  await gd.locator('button', { hasText: 'Reorder Mesh Spatially' }).click();
  // Remesh: Quad mode → QuadriFlow Remesh dialog
  const rm = await openPanel(page, 'me-remesh');
  await rm.locator('button', { hasText: /^Quad$/ }).click();
  await rm.locator('button', { hasText: 'QuadriFlow Remesh' }).click();
  const qd = page.locator('.op-dialog[data-op-dialog="object.quadriflow_remesh"]');
  await expect(qd).toBeVisible();
  await qd.locator('.op-dialog-buttons .btn').click();
  const after = await mesh(page);
  expect(after.faces).toBeGreaterThan(1000);
  await expectNoErrors(errors);
});

test('lattice data tab: interpolation per axis, outside, vertex groups', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => {
    const a = (window as Any).app;
    a.run('object.add', { type: 'LATTICE' });
    const lt = a.doc.lattices[a.activeObject.data];
    lt.points_u = lt.points_v = lt.points_w = 3;
    a.run('lattice.resize', {}, { invoke: false });
  });
  await page.locator('.rail-tab[data-tab="DATA"]').first().click();
  const lt = page.locator('[data-panel="lt"]').first();
  await expect(lt).toContainText('Interpolation U');
  await lt.locator('label', { hasText: 'Outside' }).click();
  // vertex groups: add, then assign the selection in Edit Mode, then select ungrouped
  const vg = page.locator('[data-panel="lt-groups"]').first();
  await vg.locator('.ul-side .icon-btn[data-tip="Add"]').click();
  const r = await page.evaluate(() => {
    const a = (window as Any).app;
    const lt = a.doc.lattices[a.activeObject.data];
    a.run('object.mode_set', { mode: 'EDIT' });
    lt.select = new Uint8Array(27);
    lt.select[0] = 1;
    a.run('object.vertex_group_assign');
    a.run('lattice.select_all', { action: 'DESELECT' });
    a.run('lattice.select_ungrouped');
    return { outside: lt.use_outside, groups: lt.vertex_groups.map((g: Any) => g.name), w0: lt.weights[0][0], ungrouped: Array.from(lt.select as Uint8Array).filter(Boolean).length };
  });
  expect(r).toEqual({ outside: true, groups: ['Group'], w0: 1, ungrouped: 26 });
  await expectNoErrors(errors);
});
