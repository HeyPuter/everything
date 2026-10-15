// Edit modes for curves, armatures, text and lattices: menus, shortcuts and tools.
import { test, expect, type Page } from '@playwright/test';
import { openApp, hoverViewport, expectNoErrors, viewportCenter } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const get = (page: Page, expr: string) => page.evaluate(`(() => { const app = window.app; return ${expr}; })()`);
const run = (page: Page, op: string, props: Record<string, unknown> = {}) => page.evaluate(([o, p]) => (window as any).app.run(o, p), [op, props] as const);

async function fresh(page: Page, add: string, props: Record<string, unknown> = {}) {
  await run(page, 'object.select_all', { action: 'DESELECT' });
  await run(page, add, props);
  await page.waitForTimeout(100);
  await hoverViewport(page);
}

/** Open a header menu of the 3D viewport and return its item labels. */
async function headerMenu(page: Page, name: string) {
  await page.locator('.hdr-menu', { hasText: new RegExp(`^${name.replace(/[()]/g, '\\$&')}$`) }).first().click();
  const items = await page.locator('.menu').last().locator('.menu-item').allInnerTexts();
  await page.keyboard.press('Escape');
  return items.map((t) => t.split('\n')[0].trim());
}

const CU = 'app.doc.curves[app.activeObject.data]';

test('curve edit mode: menus, selection helpers, split, dissolve, hide', async ({ page }) => {
  const errors = await openApp(page);
  await fresh(page, 'curve.primitive_bezier_circle_add');
  await page.keyboard.press('Tab');
  expect(await get(page, 'app.doc.mode')).toBe('EDIT');
  // header menus
  const curveItems = await headerMenu(page, 'Curve');
  for (const l of ['Transform', 'Mirror', 'Snap', 'Duplicate', 'Split', 'Separate', 'Toggle Cyclic', 'Set Spline Type', 'Show/Hide', 'Clean Up', 'Delete']) expect(curveItems).toContain(l);
  const sel = await headerMenu(page, 'Select');
  for (const l of ['Select Random', 'Checker Deselect', 'More', 'Less', 'Select Similar', '(De)select First', 'Select Next']) expect(sel).toContain(l);
  const cp = await headerMenu(page, 'Control Points');
  for (const l of ['Tilt', 'Clear Tilt', 'Recalculate Handles', 'Smooth', 'Smooth Curve Radius']) expect(cp).toContain(l);
  // subdivide to 8, select one point, grow with Ctrl+Numpad+
  await page.keyboard.press('a');
  await run(page, 'curve.subdivide');
  expect(await get(page, `${CU}.splines[0].bezier_points.length`)).toBe(8);
  await page.keyboard.press('Alt+a');
  await page.evaluate(() => {
    const a = (window as any).app;
    const b = a.doc.curves[a.activeObject.data].splines[0].bezier_points[2];
    b.select_control_point = b.select_left_handle = b.select_right_handle = true;
    a.changed('doc');
  });
  await page.keyboard.press('Control+NumpadAdd');
  const selIdx = () => get(page, `${CU}.splines[0].bezier_points.map((b, i) => b.select_control_point ? i : -1).filter(i => i >= 0)`);
  expect(await selIdx()).toEqual([1, 2, 3]);
  // Y splits the selected run off
  await page.keyboard.press('y');
  expect(await get(page, `${CU}.splines.map(s => s.bezier_points.length)`)).toEqual([7, 3]);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(50);
  expect(await get(page, `${CU}.splines.length`)).toBe(1);
  // Ctrl+X dissolves
  await page.keyboard.press('Control+x');
  expect(await get(page, `${CU}.splines[0].bezier_points.length`)).toBe(5);
  // H hides, Alt+H reveals
  await page.keyboard.press('Alt+a');
  await run(page, 'curve.de_select_first');
  await page.keyboard.press('h');
  expect(await get(page, `${CU}.splines[0].bezier_points.filter(b => b.hide).length`)).toBe(1);
  await page.keyboard.press('Alt+h');
  expect(await get(page, `${CU}.splines[0].bezier_points.filter(b => b.hide).length`)).toBe(0);
  // Alt+S radius with typed value, Ctrl+T tilt
  await page.keyboard.press('a');
  await page.keyboard.press('Alt+s');
  await page.keyboard.type('2');
  await page.keyboard.press('Enter');
  expect(await get(page, `${CU}.splines[0].bezier_points.map(b => b.radius)`)).toEqual([2, 2, 2, 2, 2]);
  await page.keyboard.press('Control+t');
  await page.keyboard.type('30');
  await page.keyboard.press('Enter');
  expect(await get(page, `+${CU}.splines[0].bezier_points[0].tilt.toFixed(4)`)).toBeCloseTo(Math.PI / 6, 3);
  await page.keyboard.press('Alt+t');
  expect(await get(page, `${CU}.splines[0].bezier_points[0].tilt`)).toBe(0);
  // mirror in edit mode
  const x0 = await get(page, `${CU}.splines[0].bezier_points.map(b => +b.co[0].toFixed(3))`);
  await run(page, 'transform.mirror', { axis: 0 });
  const x1 = await get(page, `${CU}.splines[0].bezier_points.map(b => +b.co[0].toFixed(3))`);
  expect((x1 as number[]).map((v) => -v + 0).sort()).toEqual((x0 as number[]).map((v) => v + 0).sort());
  await expectNoErrors(errors);
});

test('curve edit mode: toolbar draw and pen tools', async ({ page }) => {
  const errors = await openApp(page);
  await fresh(page, 'curve.primitive_bezier_curve_add');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Alt+a');
  await page.waitForSelector('.v3d-toolbar .tb-tool[data-tool="builtin.draw"]');
  const tools = await page.locator('.v3d-toolbar .tb-tool').evaluateAll((els) => els.map((e) => e.getAttribute('data-tool')));
  for (const t of ['builtin.draw', 'builtin.pen', 'builtin.extrude', 'builtin.extrude_cursor', 'builtin.radius', 'builtin.tilt']) expect(tools).toContain(t);
  expect(tools).not.toContain('builtin.inset_faces');
  const { x, y } = await viewportCenter(page);
  // draw a stroke
  await page.locator('.v3d-toolbar .tb-tool[data-tool="builtin.draw"]').dispatchEvent('pointerdown');
  await page.mouse.move(x - 150, y + 40);
  await page.mouse.down();
  for (let i = 0; i <= 30; i++) await page.mouse.move(x - 150 + i * 10, y + 40 - Math.sin(i / 5) * 60);
  await page.mouse.up();
  await page.waitForTimeout(100);
  expect(await get(page, `${CU}.splines.length`)).toBe(2);
  const drawn = (await get(page, `${CU}.splines[1].bezier_points.length`)) as number;
  expect(drawn).toBeGreaterThan(1);
  expect(drawn).toBeLessThan(12);
  // pen: click twice in empty space extends the selected (last drawn) end
  await page.locator('.v3d-toolbar .tb-tool[data-tool="builtin.pen"]').dispatchEvent('pointerdown');
  await page.keyboard.press('Alt+a');
  await page.mouse.click(x - 100, y - 120);
  await page.mouse.move(x, y - 150);
  await page.mouse.down();
  await page.mouse.move(x + 40, y - 150, { steps: 4 });
  await page.mouse.up();
  expect(await get(page, `${CU}.splines.length`)).toBe(3);
  expect(await get(page, `${CU}.splines[2].bezier_points.length`)).toBe(2);
  expect(await get(page, `${CU}.splines[2].bezier_points[1].handle_right_type`)).toBe('ALIGNED');
  await expectNoErrors(errors);
});

const AR = 'app.doc.armatures[app.activeObject.data]';

test('armature edit mode: fill, split, dissolve, names, collections, mirror', async ({ page }) => {
  const errors = await openApp(page);
  await fresh(page, 'object.armature_add');
  expect(await get(page, `${AR}.collections.map(c => c.name)`)).toEqual(['Bones']);
  await page.keyboard.press('Tab');
  const items = await headerMenu(page, 'Armature');
  for (const l of ['Bone Roll', 'Fill Between Joints', 'Split', 'Separate Bones', 'Names', 'Bone Settings', 'Bone Collections', 'Show/Hide', 'Delete']) expect(items).toContain(l);
  const sel = await headerMenu(page, 'Select');
  for (const l of ['Mirror', 'More', 'Less', 'Select Linked', 'Select Similar', 'Extend Parent']) expect(sel).toContain(l);
  // extrude twice up Z, then dissolve the middle bone into the chain
  await page.keyboard.press('Alt+a');
  await page.evaluate(() => {
    const a = (window as any).app;
    a.doc.armatures[a.activeObject.data].bones[0].select_tail = true;
    a.changed('doc');
  });
  await page.keyboard.press('e');
  await page.keyboard.type('z1');
  await page.keyboard.press('Enter');
  await page.keyboard.press('e');
  await page.keyboard.type('z1');
  await page.keyboard.press('Enter');
  const names = () => get(page, `${AR}.bones.map(b => b.name)`);
  expect(await names()).toEqual(['Bone', 'Bone.001', 'Bone.002']);
  // extruded bones inherit the collection
  expect(await get(page, `${AR}.bones.every(b => b.collections.includes('Bones'))`)).toBe(true);
  await page.evaluate(() => {
    const a = (window as any).app;
    const arm = a.doc.armatures[a.activeObject.data];
    for (const b of arm.bones) b.select = b.select_head = b.select_tail = b.name === 'Bone.001';
    a.changed('doc');
  });
  await page.keyboard.press('Control+x');
  expect(await names()).toEqual(['Bone', 'Bone.001']);
  expect(await get(page, `${AR}.bones[1].tail.map(v => +v.toFixed(3))`)).toEqual([0, 0, 3]);
  // Y splits the selected bone off its parent
  await page.keyboard.press('y');
  expect(await get(page, `${AR}.bones[1].parent`)).toBe(null);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(50);
  expect(await get(page, `${AR}.bones[1].parent`)).toBe('Bone');
  // move the second bone to +X and auto-name, then symmetrize and select mirror
  await page.keyboard.press('g');
  await page.keyboard.type('x1');
  await page.keyboard.press('Enter');
  await run(page, 'armature.autoside_names', { type: 'XAXIS' });
  expect(await names()).toEqual(['Bone', 'Bone.L']);
  await run(page, 'armature.symmetrize');
  expect(await names()).toEqual(['Bone', 'Bone.L', 'Bone.R']);
  // the mirrored bone hangs off the same (centre) parent and mirrors the tail
  expect(await get(page, `${AR}.bones[2].parent`)).toBe('Bone');
  expect(await get(page, `${AR}.bones[2].tail.map(v => +v.toFixed(3))`)).toEqual([-1, 0, 3]);
  await page.keyboard.press('Control+Shift+m');
  expect(await get(page, `${AR}.bones.filter(b => b.select).map(b => b.name)`)).toEqual(['Bone.R']);
  // flip names swaps the pair
  await page.keyboard.press('a');
  await run(page, 'armature.flip_names');
  expect(await names()).toEqual(['Bone', 'Bone.R', 'Bone.L']);
  // bone collections: new collection via Shift M "move", hide it, bones disappear from picking
  await page.keyboard.press('Alt+a');
  await page.evaluate(() => {
    const a = (window as any).app;
    const b = a.doc.armatures[a.activeObject.data].bones[1];
    b.select = b.select_head = b.select_tail = true;
    a.changed('doc');
  });
  await page.evaluate(() => (window as any).app.run('armature.move_to_collection', { collection_index: -1, new_collection_name: 'Arms' }, { invoke: false }));
  expect(await get(page, `${AR}.collections.map(c => c.name)`)).toContain('Arms');
  expect(await get(page, `${AR}.bones[1].collections`)).toEqual(['Arms']);
  await page.evaluate(() => {
    const a = (window as any).app;
    a.doc.armatures[a.activeObject.data].collections.find((c: any) => c.name === 'Arms').is_visible = false;
    a.changed('doc');
  });
  await page.keyboard.press('Alt+a');
  await page.keyboard.press('a');
  expect(await get(page, `${AR}.bones.filter(b => b.select).map(b => b.name)`)).toEqual(['Bone', 'Bone.L']);
  // X-Axis Mirror: moving a .L tail moves the .R tail mirrored
  await page.evaluate(() => {
    const a = (window as any).app;
    const arm = a.doc.armatures[a.activeObject.data];
    arm.collections.forEach((c: any) => (c.is_visible = true));
    arm.use_mirror_x = true;
    for (const b of arm.bones) b.select = b.select_head = b.select_tail = false;
    arm.bones.find((b: any) => b.name === 'Bone.L').select_tail = true;
    a.changed('doc');
  });
  await page.keyboard.press('g');
  await page.keyboard.type('x0.5');
  await page.keyboard.press('Enter');
  const tl = (await get(page, `${AR}.bones.find(b => b.name === 'Bone.L').tail.map(v => +v.toFixed(3))`)) as number[];
  const tr = (await get(page, `${AR}.bones.find(b => b.name === 'Bone.R').tail.map(v => +v.toFixed(3))`)) as number[];
  expect(tr).toEqual([-tl[0], tl[1], tl[2]]);
  await expectNoErrors(errors);
});

test('armature edit mode: fill and separate via keys, metaball mirror', async ({ page }) => {
  const errors = await openApp(page);
  await fresh(page, 'object.armature_add');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Alt+a');
  await page.evaluate(() => {
    const a = (window as any).app;
    a.doc.armatures[a.activeObject.data].bones[0].select_tail = true;
    a.changed('doc');
  });
  // one joint: fill to the 3D cursor (at the origin; the armature sits at the cursor too)
  await page.evaluate(() => ((window as any).app.doc.scene.cursor.location = [1, 0, 0]));
  await page.keyboard.press('f');
  expect(await get(page, `${AR}.bones.length`)).toBe(2);
  expect(await get(page, `${AR}.bones[1].tail.map(v => +v.toFixed(3))`)).toEqual([1, 0, 0]);
  await page.keyboard.press('p');
  expect(await get(page, `Object.values(app.doc.objects).filter(o => o.type === 'ARMATURE').length`)).toBe(2);
  expect(await get(page, `${AR}.bones.length`)).toBe(1);
  await page.keyboard.press('Tab');
  // metaball edit mode mirror via the generic edit transform
  await fresh(page, 'object.metaball_add', { type: 'BALL', location: [1, 0, 0] });
  await page.keyboard.press('Tab');
  await page.keyboard.press('a');
  await page.evaluate(() => {
    const a = (window as any).app;
    a.doc.metaballs[a.activeObject.data].elements[0].co = [0.5, 0, 0];
    // mirror around the 3D cursor, placed at the object origin
    a.doc.scene.cursor.location = [1, 0, 0];
    a.doc.scene.tool_settings.transform_pivot_point = 'CURSOR';
    a.changed('doc');
  });
  await run(page, 'transform.mirror', { axis: 0 });
  expect(await get(page, `app.doc.metaballs[app.activeObject.data].elements[0].co.map(v => +v.toFixed(3))`)).toEqual([-0.5, 0, 0]);
  await expectNoErrors(errors);
});

test('text edit mode: word moves, styles, kerning, case, menus, text boxes', async ({ page }) => {
  const errors = await openApp(page);
  await fresh(page, 'object.text_add');
  await page.waitForFunction(() => {
    const a = (window as any).app;
    return (a.graph.get(a.activeObject.id)?.mesh?.positions.length ?? 0) > 0;
  });
  await page.keyboard.press('Tab');
  const body = () => get(page, `${CU}.body`);
  await page.keyboard.press('Control+a');
  await page.keyboard.type('hello big world');
  expect(await body()).toBe('hello big world');
  // Ctrl+Left twice: before "big"; Shift+Ctrl+Right selects it; Ctrl+B bolds it
  await page.keyboard.press('Control+ArrowLeft');
  await page.keyboard.press('Control+ArrowLeft');
  await page.keyboard.press('Control+Shift+ArrowRight');
  await page.keyboard.press('Control+b');
  expect(await get(page, `${CU}.body_format.map(f => f.use_bold ? 'b' : '-').join('')`)).toBe('------bbb------');
  // To Uppercase on the selection
  await run(page, 'font.case_set', { case: 'UPPER' });
  expect(await body()).toBe('hello BIG world');
  // Ctrl+Backspace deletes the previous word
  await page.keyboard.press('End');
  await page.keyboard.press('Control+Backspace');
  expect(await body()).toBe('hello BIG ');
  // Alt+Right adds kerning to the character before the cursor
  await page.keyboard.press('Alt+ArrowRight');
  expect(await get(page, `${CU}.body_format[9].kerning`)).toBe(1);
  // menus
  const t = await headerMenu(page, 'Text');
  for (const l of ['Cut', 'Copy', 'Paste', 'Paste File…', 'To Uppercase', 'Insert Unicode…', 'Special Characters', 'Toggle Bold', 'Kerning', 'Delete']) expect(t).toContain(l);
  const s = await headerMenu(page, 'Select');
  for (const l of ['All', 'Top', 'Line Begin', 'Previous Word', 'Next Word']) expect(s).toContain(l);
  // unicode insert
  await page.evaluate(() => (window as any).app.run('font.text_insert_unicode', { code: '00E9' }, { invoke: false }));
  expect(await body()).toBe('hello BIG é');
  // text boxes: a narrow box wraps the text onto several lines
  await page.keyboard.press('Tab');
  await page.evaluate(() => {
    const a = (window as any).app;
    a.doc.curves[a.activeObject.data].text_boxes = [{ x: 0, y: 0, width: 2.5, height: 0 }];
    a.changed('doc', 'geometry');
    a.flush();
  });
  const ys = (await page.evaluate(() => {
    const a = (window as any).app;
    const p = a.graph.get(a.activeObject.id).mesh.positions;
    let min = Infinity;
    for (let i = 1; i < p.length; i += 3) min = Math.min(min, p[i]);
    return min;
  })) as number;
  expect(ys).toBeLessThan(-1);
  await expectNoErrors(errors);
});

test('lattice edit mode: select more / mirror, menus, edit-mode mirror', async ({ page }) => {
  const errors = await openApp(page);
  await fresh(page, 'object.add', { type: 'LATTICE' });
  await page.evaluate(() => {
    const a = (window as any).app;
    const lt = a.doc.lattices[a.activeObject.data];
    lt.points_u = 3;
    lt.points_v = 3;
    lt.points_w = 1;
    a.run('lattice.resize', {}, { invoke: false });
  });
  await page.keyboard.press('Tab');
  const sel = () => get(page, `[...app.doc.lattices[app.activeObject.data].select].map((v, i) => v ? i : -1).filter(i => i >= 0)`);
  await page.keyboard.press('Alt+a');
  await page.evaluate(() => {
    const a = (window as any).app;
    a.doc.lattices[a.activeObject.data].select[0] = 1;
    a.changed('doc');
  });
  await page.keyboard.press('Control+NumpadAdd');
  expect(await sel()).toEqual([0, 1, 3]);
  await run(page, 'lattice.select_mirror', { axis: 'X' });
  expect(await sel()).toEqual([1, 2, 5]);
  const items = await headerMenu(page, 'Select');
  for (const l of ['Select Mirror', 'Select Random', 'More', 'Less']) expect(items).toContain(l);
  const lat = await headerMenu(page, 'Lattice');
  for (const l of ['Transform', 'Mirror', 'Snap', 'Flip (Distortion)', 'Make Regular']) expect(lat).toContain(l);
  // mirror the selected points across the 3D cursor X
  await page.evaluate(() => {
    const a = (window as any).app;
    a.doc.scene.cursor.location = [0, 0, 0];
    a.doc.scene.tool_settings.transform_pivot_point = 'CURSOR';
  });
  const x0 = await get(page, `+app.doc.lattices[app.activeObject.data].points[2 * 3].toFixed(3)`);
  await run(page, 'transform.mirror', { axis: 0 });
  expect(await get(page, `+app.doc.lattices[app.activeObject.data].points[2 * 3].toFixed(3)`)).toBe(-(x0 as number));
  await expectNoErrors(errors);
});

test('convert text and mesh objects to curves', async ({ page }) => {
  const errors = await openApp(page);
  await fresh(page, 'object.text_add');
  await page.waitForFunction(() => {
    const a = (window as any).app;
    return (a.graph.get(a.activeObject.id)?.mesh?.positions.length ?? 0) > 0;
  });
  await run(page, 'object.convert', { target: 'CURVE' });
  expect(await get(page, 'app.activeObject.type')).toBe('CURVE');
  expect(await get(page, `${CU}.splines.length`)).toBeGreaterThan(3);
  expect(await get(page, `${CU}.dimensions`)).toBe('2D');
  await run(page, 'object.select_all', { action: 'DESELECT' });
  await page.evaluate(() => {
    const a = (window as any).app;
    const cube = Object.values(a.doc.objects).find((o: any) => o.name === 'Cube') as any;
    cube.select = true;
    a.doc.scene.active_object = cube.id;
    a.changed('doc', 'select');
  });
  await run(page, 'object.convert', { target: 'CURVE', keep_original: true });
  expect(await get(page, 'app.activeObject.type')).toBe('CURVE');
  expect(await get(page, `${CU}.splines.reduce((s, sp) => s + sp.points.length - (sp.use_cyclic_u ? 0 : 1), 0)`)).toBe(12);
  expect(await get(page, `Object.values(app.doc.objects).some(o => o.name === 'Cube' && o.type === 'MESH')`)).toBe(true);
  await expectNoErrors(errors);
});

test('text object: open a custom font file from the Font panel', async ({ page }) => {
  const errors = await openApp(page);
  await fresh(page, 'object.text_add');
  await page.waitForFunction(() => {
    const a = (window as any).app;
    return (a.graph.get(a.activeObject.id)?.mesh?.positions.length ?? 0) > 0;
  });
  const before = await get(page, 'app.graph.get(app.activeObject.id).mesh.positions.length');
  await page.locator('.rail-tab[data-tip="Data"]').first().click();
  const chooser = page.waitForEvent('filechooser');
  await page.locator('.ids-btn[data-tip="Open a font file"]').first().click();
  await (await chooser).setFiles('node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff');
  await page.waitForFunction(() => {
    const a = (window as any).app;
    return !!a.doc.curves[a.activeObject.data].font;
  });
  await page.evaluate(() => (window as any).app.flush());
  expect(await get(page, 'Object.values(app.doc.fonts).map(f => f.name)')).toEqual(['jetbrains-mono-latin-400-normal']);
  expect(await get(page, 'app.graph.get(app.activeObject.id).mesh.positions.length')).not.toBe(before);
  await expectNoErrors(errors);
});

test('metaball family members can be clicked on their rings in Object Mode', async ({ page }) => {
  const errors = await openApp(page);
  await fresh(page, 'object.metaball_add', { type: 'BALL', location: [0, 0, 0] });
  await run(page, 'object.select_all', { action: 'DESELECT' });
  await run(page, 'object.metaball_add', { type: 'BALL', location: [0, 0, 3] });
  expect(await get(page, 'app.activeObject.name')).toBe('Mball.001');
  await run(page, 'object.select_all', { action: 'DESELECT' });
  await page.waitForTimeout(100);
  // click on the top of the second ball's ring
  const p = await page.evaluate(async () => {
    const { rings } = await import('/src/metaball/edit.ts');
    const a = (window as any).app;
    const v = (a.hoverArea ?? a.activeArea).editor;
    const ob = Object.values(a.doc.objects).find((o: any) => o.name === 'Mball.001') as any;
    const g = rings(v, ob, a.doc.metaballs[ob.data])[0];
    const r = v.el.getBoundingClientRect();
    return { x: r.left + g.cx, y: r.top + g.cy - g.r };
  });
  await page.mouse.click(p.x, p.y);
  expect(await get(page, 'app.activeObject.name')).toBe('Mball.001');
  expect(await get(page, 'app.activeObject.select')).toBe(true);
  await expectNoErrors(errors);
});

test('proportional editing in curve Edit Mode', async ({ page }) => {
  const errors = await openApp(page);
  await fresh(page, 'curve.primitive_bezier_circle_add');
  await page.keyboard.press('Tab');
  await page.keyboard.press('a');
  await run(page, 'curve.subdivide');
  await page.evaluate(() => {
    const a = (window as any).app;
    a.run('curve.select_all', { action: 'DESELECT' });
    const b = a.doc.curves[a.activeObject.data].splines[0].bezier_points[0];
    b.select_control_point = b.select_left_handle = b.select_right_handle = true;
    const ts = a.doc.scene.tool_settings;
    ts.use_proportional_edit = true;
    ts.proportional_size = 1;
    ts.proportional_edit_falloff = 'LINEAR';
    a.changed('doc');
  });
  const xs = () => get(page, `${CU}.splines[0].bezier_points.map(b => +b.co[2].toFixed(3))`);
  await page.keyboard.press('g');
  await page.keyboard.type('z1');
  await page.keyboard.press('Enter');
  const z = (await xs()) as number[];
  expect(z[0]).toBe(1);
  // neighbours at ~0.77 distance move partially, the opposite side stays
  expect(z[1]).toBeGreaterThan(0);
  expect(z[1]).toBeLessThan(1);
  expect(z[4]).toBe(0);
  await page.evaluate(() => ((window as any).app.doc.scene.tool_settings.use_proportional_edit = false));
  await expectNoErrors(errors);
});

test('bevel object gives a curve its cross-section', async ({ page }) => {
  const errors = await openApp(page);
  await fresh(page, 'curve.primitive_bezier_circle_add', { radius: 0.2 });
  const circle = await get(page, 'app.activeObject.id');
  await run(page, 'object.select_all', { action: 'DESELECT' });
  await run(page, 'curve.primitive_bezier_curve_add');
  await page.locator('.rail-tab[data-tip="Data"]').first().click();
  await expect(page.locator('.sr-label', { hasText: 'Taper Object' })).toBeVisible();
  const faces = await page.evaluate((id) => {
    const a = (window as any).app;
    const cu = a.doc.curves[a.activeObject.data];
    cu.bevel_mode = 'OBJECT';
    cu.bevel_object = id;
    a.changed('doc', 'geometry');
    a.flush();
    return a.graph.get(a.activeObject.id).mesh.offsets.length - 1;
  }, circle);
  expect(faces).toBeGreaterThan(20);
  await expectNoErrors(errors);
});

test('text follows a curve path', async ({ page }) => {
  const errors = await openApp(page);
  await fresh(page, 'curve.primitive_bezier_circle_add', { radius: 3 });
  const circle = await get(page, 'app.activeObject.id');
  await run(page, 'object.select_all', { action: 'DESELECT' });
  await run(page, 'object.text_add');
  await page.waitForFunction(() => {
    const a = (window as any).app;
    return (a.graph.get(a.activeObject.id)?.mesh?.positions.length ?? 0) > 0;
  });
  const extent = (await page.evaluate((id) => {
    const a = (window as any).app;
    a.doc.curves[a.activeObject.data].follow_curve = id;
    a.changed('doc', 'geometry');
    a.flush();
    const p = a.graph.get(a.activeObject.id).mesh.positions;
    let maxR = 0;
    for (let i = 0; i < p.length; i += 3) maxR = Math.max(maxR, Math.hypot(p[i], p[i + 1]));
    return maxR;
  }, circle)) as number;
  // glyphs now sit around the circle of radius 3
  expect(extent).toBeGreaterThan(2.5);
  expect(extent).toBeLessThan(3.3);
  await expectNoErrors(errors);
});

test('Active Spline panel edits the spline of the selected points', async ({ page }) => {
  const errors = await openApp(page);
  await fresh(page, 'curve.primitive_nurbs_curve_add');
  await page.keyboard.press('Tab');
  await page.keyboard.press('a');
  await page.locator('.rail-tab[data-tip="Data"]').first().click();
  const panelEl = page.locator('section', { hasText: 'Active Spline' }).first();
  await expect(panelEl).toBeVisible();
  await panelEl.locator('label.checkbox', { hasText: 'Cyclic U' }).click();
  expect(await get(page, `${CU}.splines[0].use_cyclic_u`)).toBe(true);
  await expect(panelEl.locator('.sr-label', { hasText: 'Order U' })).toBeVisible();
  await expectNoErrors(errors);
});
