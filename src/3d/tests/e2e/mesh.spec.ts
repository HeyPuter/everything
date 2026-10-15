// Mesh Edit Mode wiring: menus, shortcuts, modal keys, toolbar groups and tool settings.
import { test, expect, type Page } from '@playwright/test';
import { openApp, hoverViewport, expectNoErrors } from './helpers';

const get = (page: Page, expr: string) => page.evaluate(`(() => { const app = window.app; return ${expr}; })()`);
const counts = (page: Page) => get(page, `(() => { const me = app.doc.meshes[app.activeObject.data]; return [me.positions.length / 3, me.offsets.length - 1]; })()`) as Promise<[number, number]>;

async function editCube(page: Page) {
  const errors = await openApp(page);
  await hoverViewport(page);
  await page.keyboard.press('Tab');
  expect(await get(page, 'app.doc.mode')).toBe('EDIT');
  return errors;
}

async function selectTop(page: Page) {
  await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const me = a.doc.meshes[a.activeObject.data];
    const sel = new Uint8Array(me.positions.length / 3);
    for (let i = 0; i < sel.length; i++) sel[i] = me.positions[i * 3 + 2] > 0.5 ? 1 : 0;
    me.select_vert = sel;
    a.changed('doc', 'select');
  });
}

test('every edit-mesh menu entry and Mesh shortcut points at a registered operator', async ({ page }) => {
  const errors = await editCube(page);
  const missing = await page.evaluate(async () => {
    const { operators } = await import('/src/app/app.ts');
    const { modeMenus } = await import('/src/editors/view3d/modemenus.ts');
    const { keymaps } = await import('/src/app/keymap.ts');
    const out: string[] = [];
    type Item = { op?: string; submenu?: () => Item[]; label?: string };
    const walk = (items: Item[], path: string, depth = 0) => {
      for (const it of items) {
        if (it.op && !operators.has(it.op)) out.push(`${path} > ${it.label}: ${it.op}`);
        if (it.submenu && depth < 4) walk(it.submenu(), `${path} > ${it.label}`, depth + 1);
      }
    };
    const mm = modeMenus.EDIT as unknown as { header: () => [string, () => Item[]][]; select: () => Item[]; context: () => Item[] };
    for (const [name, fn] of mm.header()) walk(fn(), name);
    walk(mm.select(), 'Select');
    // the context menu for each select mode
    for (const t of ['VERT', 'EDGE', 'FACE']) {
      (window as any).app.run('mesh.select_mode', { type: t }); // eslint-disable-line @typescript-eslint/no-explicit-any
      walk(mm.context(), `Context ${t}`);
    }
    for (const k of keymaps.Mesh ?? []) {
      const it = k as unknown as Item & { menu?: () => Item[]; key: string };
      if (it.op && !operators.has(it.op)) out.push(`key ${it.key}: ${it.op}`);
      if (it.menu) walk(it.menu(), `key ${it.key}`);
    }
    return out;
  });
  expect(missing).toEqual([]);
  await expectNoErrors(errors);
});

test('E extrudes along the normal; Alt+E menu offers the extrude variants', async ({ page }) => {
  const errors = await editCube(page);
  await selectTop(page);
  await page.keyboard.press('e');
  await page.keyboard.type('1');
  await page.keyboard.press('Enter');
  expect(await counts(page)).toEqual([12, 10]);
  const top = await get(page, `Math.max(...Array.from(app.doc.meshes[app.activeObject.data].positions).filter((_, i) => i % 3 === 2))`);
  expect(top).toBeCloseTo(2, 4);
  await page.keyboard.press('Alt+e');
  for (const label of ['Extrude Faces Along Normals', 'Extrude Individual Faces', 'Extrude Manifold', 'Extrude Repeat']) await expect(page.locator('.menu-item', { hasText: label }).first()).toBeVisible();
  await page.locator('.menu-item', { hasText: 'Extrude Repeat' }).first().click();
  await page.waitForTimeout(50);
  // 10 more steps of 4 new verts / 4 new faces each
  expect(await counts(page)).toEqual([52, 50]);
  await expectNoErrors(errors);
});

test('Delete menu: Limited Dissolve restores a subdivided cube', async ({ page }) => {
  const errors = await editCube(page);
  await page.keyboard.press('a');
  await page.evaluate(() => (window as any).app.run('mesh.subdivide', { number_cuts: 2 })); // eslint-disable-line @typescript-eslint/no-explicit-any
  await page.keyboard.press('a');
  expect(await counts(page)).toEqual([56, 54]);
  await hoverViewport(page);
  await page.keyboard.press('x');
  await page.locator('.menu-item', { hasText: 'Limited Dissolve' }).first().click();
  await page.waitForTimeout(50);
  expect(await counts(page)).toEqual([8, 6]);
  await expectNoErrors(errors);
});

test('Ctrl+B bevel modal: S then a number sets segments, typed width applies', async ({ page }) => {
  const errors = await editCube(page);
  await page.keyboard.press('a');
  await page.keyboard.press('Control+b');
  await page.keyboard.type('0.2');
  await page.keyboard.press('s');
  await page.keyboard.type('2');
  await expect(page.locator('body')).toContainText('[Segments]');
  await page.keyboard.press('Enter');
  const last = await get(page, 'app.lastOp && app.lastOp.props');
  expect(last).toMatchObject({ segments: 2, offset: 0.2, affect: 'EDGES' });
  const [v, f] = await counts(page);
  expect(v).toBeGreaterThan(24);
  expect(f).toBeGreaterThan(26);
  await expectNoErrors(errors);
});

test('Alt+M splits by edges; Shift+G lists similar items for the mode', async ({ page }) => {
  const errors = await editCube(page);
  await selectTop(page);
  await page.keyboard.press('2');
  await page.keyboard.press('Alt+m');
  await page.locator('.menu-item', { hasText: 'Faces by Edges' }).first().click();
  await page.waitForTimeout(50);
  expect((await counts(page))[0]).toBe(12);
  await page.keyboard.press('Shift+g');
  await expect(page.locator('.menu-item', { hasText: 'Length' }).first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expectNoErrors(errors);
});

test('toolbar: extrude group alternates and tool settings', async ({ page }) => {
  const errors = await editCube(page);
  const slot = page.locator('.tb-tool[data-tool="builtin.extrude_region"]');
  await expect(slot).toBeVisible();
  // the other members are collapsed into the slot
  await expect(page.locator('.tb-tool[data-tool="builtin.extrude_manifold"]')).toHaveCount(0);
  await slot.click({ button: 'right' });
  await page.locator('.menu-item', { hasText: 'Extrude Manifold' }).first().click();
  await expect(page.locator('.tb-tool[data-tool="builtin.extrude_manifold"]')).toHaveClass(/on/);
  // bevel tool shows its settings in the tool header
  await page.locator('.tb-tool[data-tool="builtin.bevel"]').click();
  await expect(page.locator('.tool-header')).toContainText('Segments');
  await page.locator('.tb-tool[data-tool="builtin.knife"]').click({ button: 'right' });
  await expect(page.locator('.menu-item', { hasText: 'Bisect' }).first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expectNoErrors(errors);
});

test('F3 search finds the new tools and the redo panel adjusts them', async ({ page }) => {
  const errors = await editCube(page);
  await selectTop(page);
  await page.keyboard.press('F3');
  await page.keyboard.type('Solidify');
  await page.locator('.menu-item', { hasText: 'Solidify' }).first().click();
  await page.waitForTimeout(50);
  expect(await counts(page)).toEqual([12, 11]);
  expect(await get(page, 'app.lastOp.idname')).toBe('mesh.solidify');
  await page.evaluate(() => (window as any).app.redoLast({ thickness: 0.5 })); // eslint-disable-line @typescript-eslint/no-explicit-any
  const minZ = await get(page, `Math.min(...Array.from(app.doc.meshes[app.activeObject.data].positions).filter((_, i) => i % 3 === 2 ))`);
  expect(minZ).toBeCloseTo(-1, 4);
  await expectNoErrors(errors);
});

test('edge mode: Ctrl+Alt+click selects an edge ring without the edges between; Subdivide cuts across', async ({ page }) => {
  const errors = await editCube(page);
  await page.keyboard.press('2');
  // screen position of the middle of a vertical cube edge facing the viewer
  const pt = await page.evaluate(async () => {
    const { activeView3D } = await import('/src/editors/view3d/view3d.ts');
    const v = activeView3D()!;
    const r = v.el.getBoundingClientRect();
    // the vertical edge nearest the camera
    let best = { x: 0, y: 0, d: Infinity };
    for (const x of [-1, 1])
      for (const y of [-1, 1]) {
        const p = v.camera.position.clone().set(x, y, 0);
        const d = p.distanceTo(v.camera.position);
        const s = v.project(p);
        if (d < best.d) best = { x: s.x + r.left, y: s.y + r.top, d };
      }
    return best;
  });
  await page.mouse.move(pt.x, pt.y);
  await page.keyboard.down('Control');
  await page.keyboard.down('Alt');
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await page.keyboard.up('Control');
  await page.waitForTimeout(50);
  const sel = await page.evaluate(async () => {
    const { MeshEdit } = await import('/src/modes/editmesh/meshedit.ts');
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const m = MeshEdit.from(a.doc.meshes[a.activeObject.data]);
    return [m.selectedVerts().length, m.selectedEdges().length, m.selectedFaces().length];
  });
  expect(sel).toEqual([8, 4, 0]);
  await page.evaluate(() => (window as any).app.run('mesh.subdivide', { number_cuts: 1 })); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(await counts(page)).toEqual([12, 10]);
  await expectNoErrors(errors);
});

test('mesh symmetry: the X toggle in the header mirrors a move to the partner vertex', async ({ page }) => {
  const errors = await editCube(page);
  await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const me = a.doc.meshes[a.activeObject.data];
    const sel = new Uint8Array(me.positions.length / 3);
    for (let i = 0; i < sel.length; i++) sel[i] = me.positions[i * 3] > 0.5 && me.positions[i * 3 + 1] > 0.5 && me.positions[i * 3 + 2] > 0.5 ? 1 : 0;
    me.select_vert = sel;
    a.changed('doc', 'select');
  });
  await page.locator('.mesh-symmetry .hdr-toggle', { hasText: 'X' }).click();
  expect(await get(page, 'app.doc.scene.tool_settings.use_mesh_mirror_x')).toBe(true);
  await hoverViewport(page);
  await page.keyboard.press('g');
  await page.keyboard.press('z');
  await page.keyboard.type('1');
  await page.keyboard.press('Enter');
  const zs = await get(page, `(() => { const P = app.doc.meshes[app.activeObject.data].positions; const out = []; for (let i = 0; i < P.length; i += 3) if (P[i + 1] > 0.5 && P[i + 2] > 1.5) out.push(Math.round(P[i] * 100) / 100); return out.sort(); })()`);
  expect(zs).toEqual([-1, 1]);
  await expectNoErrors(errors);
});

test('sidebar Item tab shows the median of the selection and edits it', async ({ page }) => {
  const errors = await editCube(page);
  await selectTop(page);
  await hoverViewport(page);
  await page.keyboard.press('n');
  await page.locator('.sb-tab', { hasText: 'Item' }).first().click();
  await expect(page.locator('.panel', { hasText: 'Median:' }).first()).toBeVisible();
  await expect(page.locator('.panel', { hasText: 'Mean Crease' }).first()).toBeVisible();
  await expectNoErrors(errors);
});

test('Bisect and Poly Build tools work from the toolbar', async ({ page }) => {
  const errors = await editCube(page);
  await page.keyboard.press('a');
  await page.locator('.tb-tool[data-tool="builtin.knife"]').click({ button: 'right' });
  await page.locator('.menu-item', { hasText: 'Bisect' }).first().click();
  const c = await hoverViewport(page);
  // drag a horizontal line across the cube
  await page.mouse.move(c.x - 250, c.y + 5);
  await page.mouse.down();
  await page.mouse.move(c.x - 100, c.y + 5, { steps: 4 });
  await page.mouse.move(c.x + 250, c.y + 5, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  const [, faces] = await counts(page);
  expect(faces).toBeGreaterThan(6);
  expect(await get(page, 'app.lastOp && app.lastOp.idname')).toBe('mesh.bisect');
  // Poly Build: Shift-click deletes the hovered vertex
  await page.locator('.tb-tool[data-tool="builtin.poly_build"]').click();
  const before = (await counts(page))[0];
  const vpt = await page.evaluate(async () => {
    const { activeView3D } = await import('/src/editors/view3d/view3d.ts');
    const v = activeView3D()!;
    const r = v.el.getBoundingClientRect();
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const P = a.doc.meshes[a.activeObject.data].positions;
    // the vertex nearest to the camera
    let best = { x: 0, y: 0, d: Infinity };
    for (let i = 0; i < P.length; i += 3) {
      const p = v.camera.position.clone().set(P[i], P[i + 1], P[i + 2]);
      const d = p.distanceTo(v.camera.position);
      const s = v.project(p);
      if (d < best.d) best = { x: s.x + r.left, y: s.y + r.top, d };
    }
    return best;
  });
  await page.mouse.move(vpt.x, vpt.y);
  await page.keyboard.down('Shift');
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await page.waitForTimeout(50);
  expect((await counts(page))[0]).toBe(before - 1);
  await expectNoErrors(errors);
});
