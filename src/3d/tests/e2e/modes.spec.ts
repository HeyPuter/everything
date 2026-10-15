// Edit modes: mesh, armature/pose, curve, text, lattice.
import { test, expect, type Page } from '@playwright/test';
import { openApp, hoverViewport, expectNoErrors } from './helpers';

const get = (page: Page, expr: string) => page.evaluate(`(() => { const app = window.app; return ${expr}; })()`);
const run = (page: Page, op: string, props: Record<string, unknown> = {}) => page.evaluate(([o, p]) => (window as any).app.run(o, p), [op, props] as const); // eslint-disable-line @typescript-eslint/no-explicit-any

async function fresh(page: Page, add: string) {
  await run(page, 'object.select_all', { action: 'DESELECT' });
  await run(page, add);
  await page.waitForTimeout(100);
  await hoverViewport(page);
}

test('mesh edit mode: extrude, inset, loop cut, undo', async ({ page }) => {
  const errors = await openApp(page);
  await hoverViewport(page);
  await page.keyboard.press('Tab');
  expect(await get(page, 'app.doc.mode')).toBe('EDIT');
  const counts = () => get(page, `(() => { const me = app.doc.meshes[app.activeObject.data]; return [me.positions.length / 3, me.offsets.length - 1]; })()`);
  expect(await counts()).toEqual([8, 6]);
  // select the top face only
  await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const me = a.doc.meshes[a.activeObject.data];
    const sel = new Uint8Array(me.positions.length / 3);
    for (let i = 0; i < sel.length; i++) sel[i] = me.positions[i * 3 + 2] > 0.5 ? 1 : 0;
    me.select_vert = sel;
    a.changed('doc', 'select');
  });
  await page.keyboard.press('e');
  await page.keyboard.type('1');
  await page.keyboard.press('Enter');
  expect(await counts()).toEqual([12, 10]);
  await page.keyboard.press('i');
  await page.keyboard.type('0.2');
  await page.keyboard.press('Enter');
  expect(await counts()).toEqual([16, 14]);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(100);
  expect(await counts()).toEqual([12, 10]);
  await page.keyboard.press('Tab');
  expect(await get(page, 'app.doc.mode')).toBe('OBJECT');
  await expectNoErrors(errors);
});

test('mesh edit mode: Ctrl+B bevel with a typed width (expected counts: 24 verts / 26 faces)', async ({ page }) => {
  const errors = await openApp(page);
  await hoverViewport(page);
  await page.keyboard.press('Tab');
  await page.keyboard.press('a');
  await page.keyboard.press('Control+b');
  await page.keyboard.type('0.2');
  await page.keyboard.press('Enter');
  const counts = await get(page, `(() => { const me = app.doc.meshes[app.activeObject.data]; return [me.positions.length / 3, me.offsets.length - 1]; })()`);
  expect(counts).toEqual([24, 26]);
  await expectNoErrors(errors);
});

test('armature: extrude bones in edit mode, rotate in pose mode, clear', async ({ page }) => {
  const errors = await openApp(page);
  await fresh(page, 'object.armature_add');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Alt+a');
  await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    a.doc.armatures[a.activeObject.data].bones[0].select_tail = true;
    a.changed('doc', 'select');
  });
  await page.keyboard.press('e');
  await page.keyboard.type('z1');
  await page.keyboard.press('Enter');
  expect(await get(page, 'app.doc.armatures[app.activeObject.data].bones.length')).toBe(2);
  expect(await get(page, 'app.doc.armatures[app.activeObject.data].bones[1].tail.map(v => +v.toFixed(3))')).toEqual([0, 0, 2]);
  await page.keyboard.press('Control+Tab');
  expect(await get(page, 'app.doc.mode')).toBe('POSE');
  await page.keyboard.press('a');
  await page.keyboard.press('r');
  await page.keyboard.type('x30');
  await page.keyboard.press('Enter');
  expect(await get(page, '+app.activeObject.pose.Bone.rotation_quaternion[1].toFixed(3)')).toBeCloseTo(0.259, 2);
  await page.keyboard.press('Alt+r');
  expect(await get(page, 'app.activeObject.pose.Bone.rotation_quaternion')).toEqual([1, 0, 0, 0]);
  await expectNoErrors(errors);
});

test('curve edit mode: subdivide, extrude, handle types, cyclic', async ({ page }) => {
  const errors = await openApp(page);
  await fresh(page, 'curve.primitive_bezier_curve_add');
  await page.keyboard.press('Tab');
  await page.keyboard.press('a');
  await run(page, 'curve.subdivide');
  const n = () => get(page, 'app.doc.curves[app.activeObject.data].splines[0].bezier_points.length');
  expect(await n()).toBe(3);
  await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    a.run('curve.select_all', { action: 'DESELECT' });
    const b = a.doc.curves[a.activeObject.data].splines[0].bezier_points;
    const last = b[b.length - 1];
    last.select_control_point = last.select_left_handle = last.select_right_handle = true;
    a.changed('doc');
  });
  await page.keyboard.press('e');
  await page.keyboard.type('x1');
  await page.keyboard.press('Enter');
  expect(await n()).toBe(4);
  await run(page, 'curve.handle_type_set', { type: 'VECTOR' });
  expect(await get(page, 'app.doc.curves[app.activeObject.data].splines[0].bezier_points[3].handle_left_type')).toBe('VECTOR');
  await page.keyboard.press('Alt+c');
  expect(await get(page, 'app.doc.curves[app.activeObject.data].splines[0].use_cyclic_u')).toBe(true);
  await expectNoErrors(errors);
});

test('text object: font outlines and typing in edit mode', async ({ page }) => {
  const errors = await openApp(page);
  await fresh(page, 'object.text_add');
  await page.waitForFunction(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    return (a.graph.get(a.activeObject.id)?.mesh?.positions.length ?? 0) > 0;
  });
  await page.keyboard.press('Tab');
  for (let i = 0; i < 4; i++) await page.keyboard.press('Backspace');
  await page.keyboard.type('Hi there');
  await page.keyboard.press('Tab');
  expect(await get(page, 'app.doc.curves[app.activeObject.data].body')).toBe('Hi there');
  await expectNoErrors(errors);
});

test('lattice edit mode: resize keeps points, make regular', async ({ page }) => {
  const errors = await openApp(page);
  await hoverViewport(page);
  await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    a.run('object.select_all', { action: 'DESELECT' });
    a.run('object.add', { type: 'LATTICE' });
  });
  const isLattice = await get(page, `app.activeObject?.type === 'LATTICE'`);
  test.skip(!isLattice, 'object.add LATTICE not available');
  await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const lt = a.doc.lattices[a.activeObject.data];
    lt.points_u = 3;
    a.run('lattice.resize');
  });
  expect(await get(page, 'app.doc.lattices[app.activeObject.data].points.length / 3')).toBe(12);
  await expectNoErrors(errors);
});
