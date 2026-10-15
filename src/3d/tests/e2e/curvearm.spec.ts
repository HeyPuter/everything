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
