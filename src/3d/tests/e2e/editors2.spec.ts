import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const win = (page: Page) => page.evaluate.bind(page);

/** Double-click a number field and type a value (or expression) into it. */
async function typeInto(page: Page, field: ReturnType<Page['locator']>, text: string) {
  await field.dblclick();
  const input = page.locator('input.editing');
  await expect(input).toBeVisible();
  await input.fill(text);
  await input.press('Enter');
  await expect(input).toHaveCount(0);
}

async function setAreaType(page: Page, from: string, to: string, maximize = false) {
  await page.evaluate(
    async ([f, t, m]) => {
      const { shell } = await import('/src/ui/shell.ts');
      const a = shell.screen.areas.find((x: { type: string }) => x.type === f) ?? shell.screen.areas[shell.screen.areas.length - 1];
      a.setType(t);
      if (m) shell.screen.toggleMaximize(a);
    },
    [from, to, maximize] as const,
  );
  await page.waitForTimeout(150);
}

test('Ctrl D adds a driver and edits it in a popover; #expression drives a field', async ({ page }) => {
  const errors = await openApp(page);
  await page.locator('.rail-tab[data-tab="OBJECT"]').first().click();
  const fields = page.locator('.properties .num-field');
  await fields.nth(0).hover();
  await page.keyboard.press('Control+d');
  const pop = page.locator('.drv-popover');
  await expect(pop).toBeVisible();
  await expect(pop).toContainText('X Location');
  const expr = pop.locator('.drv-expr input');
  await expr.fill('frame * 2');
  await expr.press('Enter');
  await win(page)(() => (window as any).app.setFrame(12));
  await expect.poll(() => win(page)(() => (window as any).app.activeObject.location[0])).toBe(24);
  await expect(fields.nth(0)).toHaveClass(/anim-driven/);
  // the popover can open the Drivers editor focused on the driver
  await pop.locator('button', { hasText: 'Show in Drivers Editor' }).click();
  await expect(page.locator('.area[data-editor="DRIVERS"]')).toHaveCount(1);
  await expect(page.locator('.area[data-editor="DRIVERS"] .anim-ch-row.k-driver')).toContainText('X Location');
  await page.mouse.move(5, 300);
  // "#expr" typed into a field makes a scripted driver
  await expect(page.locator('.area-window .area[data-editor="DRIVERS"]')).toHaveCount(1);
  await page.evaluate(async () => {
    const w = await import('/src/ui/areawindow.ts');
    for (const id of [...w.areaWindows.keys()]) w.closeAreaWindow(id);
  });
  await typeInto(page, fields.nth(1), '#frame/4');
  await expect.poll(() => win(page)(() => (window as any).app.activeObject.location[1])).toBe(3);
  const exprs = await win(page)(() => (window as any).app.activeObject.animation_data.drivers.map((d: any) => d.expression));
  expect(exprs).toEqual(['frame * 2', 'frame/4']);
  await expectNoErrors(errors);
});

test('Drivers editor: variables, targets, keys on the driver curve and modifiers', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => {
    const app = (window as any).app;
    app.run('anim.driver_button_add', { object: app.activeObject.id, data_path: 'location', index: 2 }, { invoke: false });
  });
  await setAreaType(page, 'TIMELINE', 'DRIVERS', true);
  const area = page.locator('.area[data-editor="DRIVERS"]');
  await expect(area.locator('.anim-drv-prop')).toContainText('Z Location');
  // the new driver reads nothing yet
  await expect(area.locator('.anim-drv-error')).toContainText('no data-block');
  // switch the variable to a Transform Channel of the camera
  await area.locator('.drv-vtype').first().dispatchEvent('pointerdown');
  await page.locator('.menu-item', { hasText: 'Transform Channel' }).click();
  await expect(area.locator('.anim-drv-var').first()).toContainText('Space');
  await area.locator('.drv-id').first().dispatchEvent('pointerdown');
  await page.locator('.menu-item', { hasText: 'Camera' }).click();
  await expect(area.locator('.anim-drv-error')).toHaveCount(0);
  const camX = await win(page)(() => Object.values((window as any).app.doc.objects).find((o: any) => o.type === 'CAMERA').location[0]);
  await expect.poll(() => win(page)(() => (window as any).app.activeObject.location[2])).toBeCloseTo(camX as number, 4);
  // scripted expression with two variables
  await area.locator('button', { hasText: 'Add Input Variable' }).click();
  await expect(area.locator('.anim-drv-var')).toHaveCount(2);
  await area.locator('.drv-id').nth(1).dispatchEvent('pointerdown');
  await page.locator('.menu-item', { hasText: 'Cube' }).click();
  const path = area.locator('.anim-drv-var').nth(1).locator('.text-field input').nth(1);
  await path.fill('scale[0]');
  await path.press('Enter');
  const expr = area.locator('.drv-expr input');
  await expr.fill('var + var_001 * 10');
  await expr.press('Enter');
  await expect.poll(() => win(page)(() => (window as any).app.activeObject.location[2])).toBeCloseTo((camX as number) + 10, 4);
  // invalid expressions show an error and leave the value alone
  await expr.fill('var +');
  await expr.press('Enter');
  await expect(area.locator('.anim-drv-error')).toContainText('SyntaxError');
  await expr.fill('var');
  await expr.press('Enter');
  // insert a key on the driver curve at the current driver value: the default Generator goes away
  const box = (await area.locator('canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press('i');
  await page.locator('.menu-item').first().click();
  const fc = await win(page)(() => (window as any).app.activeObject.animation_data.drivers[0].fcurve);
  expect(fc.keyframe_points.length).toBe(1);
  expect(fc.keyframe_points[0].co[0]).toBeCloseTo(camX as number, 4);
  expect(fc.modifiers.length).toBe(0);
  // modifiers tab works on the driver curve
  await area.locator('.sb-tab', { hasText: 'Modifiers' }).click();
  await area.locator('button', { hasText: 'Add Modifier' }).click();
  await page.locator('.menu-item', { hasText: 'Generator' }).click();
  await expect.poll(() => win(page)(() => (window as any).app.activeObject.animation_data.drivers[0].fcurve.modifiers.map((m: any) => m.type))).toEqual(['GENERATOR']);
  // copy / paste variables between drivers through the Channel menu
  await area.locator('.sb-tab', { hasText: 'Drivers' }).click();
  await area.locator('.drv-icon-btn').first().click();
  await page.evaluate(() => {
    const app = (window as any).app;
    app.run('anim.driver_button_add', { object: app.activeObject.id, data_path: 'scale', index: 1 }, { invoke: false });
    app.run('graph.driver_variables_paste', { object: app.activeObject.id, data_path: 'scale', index: 1, replace: true });
  });
  const names = await win(page)(() => (window as any).app.activeObject.animation_data.drivers[1].variables.map((v: any) => v.name));
  expect(names).toEqual(['var', 'var_001']);
  await expectNoErrors(errors);
});

test('Copy as New Driver and Paste Driver from the property menu', async ({ page }) => {
  const errors = await openApp(page);
  await page.locator('.rail-tab[data-tab="OBJECT"]').first().click();
  const fields = page.locator('.properties .num-field');
  await page.evaluate(() => ((window as any).app.activeObject.location[0] = 1.5));
  await page.evaluate(() => (window as any).app.changed('doc'));
  await fields.nth(0).click({ button: 'right' });
  await page.locator('.menu-item', { hasText: 'Copy as New Driver' }).click();
  await fields.nth(6).click({ button: 'right' });
  await page.locator('.menu-item', { hasText: 'Paste Driver' }).click();
  await expect.poll(() => win(page)(() => (window as any).app.activeObject.scale[0])).toBe(1.5);
  await expectNoErrors(errors);
});

// ---------------------------------------------------------------------------
// Spreadsheet

async function openSpreadsheet(page: Page) {
  await setAreaType(page, 'TIMELINE', 'SPREADSHEET', true);
  return page.locator('.area[data-editor="SPREADSHEET"]');
}

test('Spreadsheet: data set region, sorting, columns, filters and copying cells', async ({ page }) => {
  const errors = await openApp(page);
  const ss = await openSpreadsheet(page);
  const count = (label: string) => ss.locator('.ss-left-row', { hasText: label }).first().locator('.ss-left-count');
  await expect(count('Vertex')).toHaveText('8');
  await expect(count('Edge')).toHaveText('12');
  await expect(count('Face Corner')).toHaveText('24');
  await ss.locator('.ss-left-row', { hasText: 'Face' }).first().click();
  await expect(ss.locator('.ss-footer')).toContainText('Rows: 6');
  await ss.locator('.ss-left-row', { hasText: 'Vertex' }).first().click();
  // sort by clicking the header: ascending, descending, off
  const pos = ss.locator('.ss-hcell[data-col="position"]');
  const firstIndex = () => ss.locator('.ss-row').first().locator('.ss-idx').textContent();
  const xs = await page.evaluate(() => Array.from((window as any).app.doc.meshes[(window as any).app.activeObject.data].positions as Float32Array).filter((_, i) => i % 3 === 0));
  const minX = xs.indexOf(Math.min(...xs));
  await pos.click();
  await expect(pos).toHaveClass(/sorted/);
  expect(Number(await firstIndex())).toBe(minX);
  await pos.click();
  expect(xs[Number(await firstIndex())]).toBe(Math.max(...xs));
  await pos.click();
  await expect(pos).not.toHaveClass(/sorted/);
  // resize by dragging the edge, fit by double-clicking it
  const box = (await pos.boundingBox())!;
  await page.mouse.move(box.x + box.width - 3, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 80, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  expect(Math.round((await pos.boundingBox())!.width)).toBeGreaterThan(box.width + 60);
  await pos.locator('.ss-resize').dblclick();
  expect((await pos.boundingBox())!.width).toBeLessThan(box.width + 60);
  // drag Normal in front of position
  const nrm = ss.locator('.ss-hcell[data-col="Normal"]');
  const nb = (await nrm.boundingBox())!;
  const pb = (await pos.boundingBox())!;
  await page.mouse.move(nb.x + 20, nb.y + 10);
  await page.mouse.down();
  await page.mouse.move(pb.x + 5, pb.y + 10, { steps: 6 });
  await page.mouse.up();
  await expect(ss.locator('.ss-hcell[data-col]').first()).toHaveAttribute('data-col', 'Normal');
  // hide a column from its context menu, show it again from the sidebar
  await nrm.click({ button: 'right' });
  await page.locator('.menu-item', { hasText: 'Hide Column' }).click();
  await expect(ss.locator('.ss-hcell[data-col="Normal"]')).toHaveCount(0);
  await page.mouse.move(400, 400);
  await page.keyboard.press('n');
  await expect(ss.locator('.ss-side')).toBeVisible();
  await ss.locator('.ss-colrow', { hasText: 'Normal' }).locator('.checkbox').click();
  await expect(ss.locator('.ss-hcell[data-col="Normal"]')).toHaveCount(1);
  // a row filter on position: x greater than 0
  await ss.locator('button', { hasText: 'Add Row Filter' }).click();
  const filter = ss.locator('.ss-filter').first();
  await filter.locator('.ss-fcol').dispatchEvent('pointerdown');
  await page.locator('.menu-item', { hasText: 'position' }).click();
  await filter.locator('.enum-menu', { hasText: 'Equal To' }).dispatchEvent('pointerdown');
  await page.locator('.menu-item', { hasText: 'Greater Than' }).click();
  for (const k of [1, 2]) await typeInto(page, filter.locator('.num-field').nth(k), '-10');
  await expect(ss.locator('.ss-footer')).toContainText(`Rows: ${xs.filter((x) => x > 0).length} / 8`);
  // disabling the rule (or the whole filter) brings every row back
  await filter.locator('.ss-filter-hdr .checkbox').click();
  await expect(ss.locator('.ss-footer')).toContainText('Rows: 8');
  await filter.locator('.ss-filter-hdr .checkbox').click();
  await ss.locator('.ss-filter .anim-tg').first().click();
  await expect(ss.locator('.ss-filter')).toHaveCount(0);
  await expect(ss.locator('.ss-footer')).toContainText('Rows: 8');
  // select cells by dragging and copy them as tab-separated text
  const c0 = (await ss.locator('.ss-row').nth(0).locator('.ss-cell').nth(1).boundingBox())!;
  const c1 = (await ss.locator('.ss-row').nth(1).locator('.ss-cell').nth(2).boundingBox())!;
  await page.mouse.move(c0.x + 10, c0.y + 8);
  await page.mouse.down();
  await page.mouse.move(c1.x + 10, c1.y + 8, { steps: 3 });
  await page.mouse.up();
  await expect(ss.locator('.ss-footer')).toContainText('Selected: 2 × 2');
  // Shift + arrow keys extend the block
  await page.keyboard.press('Shift+ArrowDown');
  await expect(ss.locator('.ss-footer')).toContainText('Selected: 3 × 2');
  await page.keyboard.press('Shift+ArrowUp');
  await page.keyboard.press('Control+c');
  const copied: string = await page.evaluate(async () => {
    const { shell } = await import('/src/ui/shell.ts');
    return shell.screen.findArea('SPREADSHEET').editor.copied;
  });
  expect(copied.split('\n').length).toBe(2);
  expect(copied.split('\n')[0].split('\t').length).toBe(6); // two vector columns
  await expectNoErrors(errors);
});

test('Spreadsheet: pinning, selected only in Edit Mode, instances and 100k rows', async ({ page }) => {
  const errors = await openApp(page);
  const ss = await openSpreadsheet(page);
  // pin the cube, then make the camera active
  await ss.locator('.hdr-toggle').first().click();
  await page.evaluate(() => {
    const app = (window as any).app;
    app.activeObject = Object.values(app.doc.objects).find((o: any) => o.type === 'CAMERA');
    app.changed('select');
  });
  await expect(ss.locator('.ss-crumb').first()).toContainText('Cube');
  await ss.locator('.hdr-toggle').first().click();
  await expect(ss.locator('.ss-crumb').first()).toContainText('Camera');
  await page.evaluate(() => {
    const app = (window as any).app;
    app.activeObject = Object.values(app.doc.objects).find((o: any) => o.name === 'Cube');
    app.changed('select');
  });
  // Edit Mode: only the selected vertices
  await page.evaluate(() => {
    const app = (window as any).app;
    app.run('object.mode_set', { mode: 'EDIT' });
    const me = app.doc.meshes[app.activeObject.data];
    me.select_vert = new Uint8Array(me.positions.length / 3);
    me.select_vert[0] = me.select_vert[3] = 1;
    app.changed('select');
  });
  await ss.locator('.hdr-toggle').nth(1).click();
  await expect(ss.locator('.ss-footer')).toContainText('Rows: 2 / 8');
  await ss.locator('.hdr-toggle').nth(1).click();
  await page.evaluate(() => (window as any).app.run('object.mode_set', { mode: 'OBJECT' }));
  // a large mesh scrolls through virtual rows
  await page.evaluate(() => (window as any).app.run('mesh.primitive_grid_add', { x_subdivisions: 316, y_subdivisions: 316, size: 2 }));
  await expect(ss.locator('.ss-left-row', { hasText: 'Vertex' }).first().locator('.ss-left-count')).toHaveText('100K');
  expect(await ss.locator('.ss-row').count()).toBeLessThan(120);
  await ss.locator('.ss-body').evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(ss.locator('.ss-row .ss-idx', { hasText: '100488' })).toHaveCount(1);
  await expectNoErrors(errors);
});

test('Spreadsheet: instances list their references and nested geometry', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(async () => {
    const app = (window as any).app;
    const { addNode, connect, ctxOf } = await import('/src/nodes/tree.ts');
    const { geometryNodesTree, uid } = await import('/src/data/defaults.ts');
    app.run('object.modifier_add', { type: 'NODES' });
    const ob = app.activeObject;
    const id = uid('ng');
    const t = geometryNodesTree();
    app.doc.node_groups[id] = { id, name: 'Scatter', tree: t, is_modifier: true };
    ob.modifiers[ob.modifiers.length - 1].node_group = id;
    const out = t.nodes.find((n: any) => n.type === 'NodeGroupOutput');
    const grid = addNode(t, 'GeometryNodeMeshGrid', [0, 0]);
    Object.assign(grid.inputs, { 'Vertices X': 3, 'Vertices Y': 3 });
    const cube = addNode(t, 'GeometryNodeMeshCube', [0, 0]);
    const iop = addNode(t, 'GeometryNodeInstanceOnPoints', [0, 0]);
    t.links = t.links.filter((l: any) => l.to_node !== out.id);
    const c = ctxOf(app.doc, t);
    connect(c, grid.id, 'Mesh', iop.id, 'Points');
    connect(c, cube.id, 'Mesh', iop.id, 'Instance');
    connect(c, iop.id, 'Instances', out.id, 'Geometry');
    app.changed('doc');
  });
  const ss = await openSpreadsheet(page);
  await ss.locator('.ss-left-row', { hasText: 'Instances' }).first().click();
  await expect(ss.locator('.ss-footer')).toContainText('Rows: 9');
  await expect(ss.locator('.ss-hcell[data-col="Transform"]')).toHaveCount(1);
  await ss.locator('.ss-left-node').first().click();
  await ss.locator('.ss-left-row', { hasText: 'Vertex' }).nth(1).click();
  await expect(ss.locator('.ss-footer')).toContainText('Rows: 8');
  await expect(ss.locator('.ss-crumbs')).toContainText('Geometry 0');
  await expectNoErrors(errors);
});
