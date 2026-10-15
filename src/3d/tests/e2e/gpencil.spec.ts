// Grease Pencil: Draw / Edit Mode menus and shortcuts, interpolation, clean up.
import { test, expect, type Page } from '@playwright/test';
import { openApp, hoverViewport, expectNoErrors } from './helpers';

const get = (page: Page, expr: string) => page.evaluate(`(() => { const app = window.app; return ${expr}; })()`);
const run = (page: Page, op: string, props: Record<string, unknown> = {}) => page.evaluate(([o, p]) => (window as any).app.run(o, p, { invoke: false }), [op, props] as const); // eslint-disable-line @typescript-eslint/no-explicit-any

const gp = `app.doc.grease_pencils[app.activeObject.data]`;
const strokeCount = (page: Page) => get(page, `${gp}.drawings.reduce((a, d) => a + d.offsets.length - 1, 0)`) as Promise<number>;

async function strokeObject(page: Page, mode: string) {
  await run(page, 'object.select_all', { action: 'SELECT' });
  await run(page, 'object.delete');
  await run(page, 'object.grease_pencil_add', { type: 'STROKE' });
  await run(page, 'object.mode_set', { mode });
  await page.waitForTimeout(100);
  await hoverViewport(page);
}

async function headerMenu(page: Page, label: string) {
  await page.locator('.hdr-menu', { hasText: new RegExp(`^${label}$`) }).first().dispatchEvent('pointerdown');
  await page.waitForSelector('.menu');
}

test('draw mode: Draw menu, layer / keyframe shortcuts, interpolation', async ({ page }) => {
  const errors = await openApp(page);
  await strokeObject(page, 'PAINT_GREASE_PENCIL');
  await headerMenu(page, 'Draw');
  for (const item of ['Active Layer', 'Animation', 'Interpolate Sequence', 'Show/Hide', 'Clean Up', 'Sample Color']) await expect(page.locator('.menu .menu-item', { hasText: item }).first()).toBeVisible();
  await page.keyboard.press('Escape');
  await hoverViewport(page);
  // H hides the active layer, Alt H shows all
  await page.keyboard.press('h');
  expect(await get(page, `${gp}.layers[${gp}.active_layer_index].hide`)).toBe(true);
  await page.keyboard.press('Alt+h');
  expect(await get(page, `${gp}.layers.every((l) => !l.hide)`)).toBe(true);
  // Numpad * isolates the active layer
  await page.keyboard.press('NumpadMultiply');
  expect(await get(page, `${gp}.layers.filter((l) => l.lock).length`)).toBe(1);
  await page.keyboard.press('NumpadMultiply');
  // Shift I inserts a blank keyframe on frame 10, then Shift Ctrl E interpolates frames 2-9
  await page.evaluate(() => (window as any).app.setFrame(10)); // eslint-disable-line @typescript-eslint/no-explicit-any
  await page.keyboard.press('Shift+i');
  const keys = () => get(page, `${gp}.layers[${gp}.active_layer_index].frames.map((f) => f.frame_number + ':' + f.keyframe_type[0])`);
  expect(await keys()).toEqual(['1:K', '10:K']);
  // give the blank key the strokes of frame 1, moved up
  await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const g = a.doc.grease_pencils[a.activeObject.data];
    const l = g.layers[g.active_layer_index];
    const src = g.drawings[l.frames[0].drawing];
    const pos = src.position.slice();
    for (let i = 2; i < pos.length; i += 3) pos[i] += 1;
    g.drawings[l.frames[1].drawing] = { ...src, position: pos };
    a.pushUndo('Test Drawing');
    a.changed('doc');
  });
  await page.evaluate(() => (window as any).app.setFrame(5)); // eslint-disable-line @typescript-eslint/no-explicit-any
  await page.keyboard.press('Shift+Control+e');
  expect(await keys()).toEqual(['1:K', '2:B', '3:B', '4:B', '5:B', '6:B', '7:B', '8:B', '9:B', '10:K']);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(50);
  await page.evaluate(() => (window as any).app.setFrame(5)); // eslint-disable-line @typescript-eslint/no-explicit-any
  // Ctrl E: one breakdown on the current frame, confirmed with Enter
  await page.keyboard.press('Control+e');
  await page.keyboard.press('Enter');
  expect(await keys()).toEqual(['1:K', '5:B', '10:K']);
  // Alt I ▸ delete the active keyframe
  await page.keyboard.press('Alt+i');
  await page.locator('.menu .menu-item', { hasText: 'Delete Active Keyframe (Active Layer)' }).click();
  expect(await keys()).toEqual(['1:K', '10:K']);
  // [ / ] scale the brush
  const size = () => get(page, `app.doc.scene.tool_settings.gpencil_brushes['builtin.brush.Draw'].size`);
  const s0 = (await size()) as number;
  await page.keyboard.press(']');
  expect(await size()).toBeGreaterThan(s0);
  await expectNoErrors(errors);
});

test('edit mode: menus and shortcuts', async ({ page }) => {
  const errors = await openApp(page);
  await strokeObject(page, 'EDIT');
  for (const [menu, items] of [
    ['Grease Pencil', ['Transform', 'Mirror', 'Snap', 'Active Layer', 'Animation', 'Interpolate Sequence', 'Duplicate', 'Split', 'Copy', 'Paste', 'Show/Hide', 'Separate', 'Clean Up', 'Outline', 'Delete']],
    ['Stroke', ['Subdivide', 'Subdivide and Smooth', 'Simplify Stroke', 'Join', 'Move to Layer', 'Assign Material', 'Arrange', 'Close', 'Toggle Cyclic', 'Set Caps', 'Switch Direction', 'Set Start Point', 'Set Uniform Thickness', 'Set Uniform Opacity']],
    ['Point', ['Extrude', 'Smooth']],
    ['Select', ['All', 'None', 'Invert', 'Random', 'Alternated', 'More', 'Less', 'Select Similar', 'Fill', 'Linked', 'First', 'Last']],
  ] as const) {
    await headerMenu(page, menu);
    for (const item of items) await expect(page.locator('.menu .menu-item', { hasText: item }).first(), `${menu} ▸ ${item}`).toBeVisible();
    await page.keyboard.press('Escape');
  }
  await hoverViewport(page);
  await page.keyboard.press('a');
  const n0 = await strokeCount(page);
  // Ctrl C / Ctrl V duplicate the selection into the active layer
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  expect(await strokeCount(page)).toBe(n0 + 3);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(50);
  // E extrudes and moves: confirm right away
  await page.keyboard.press('e');
  await page.keyboard.press('Enter');
  expect(await strokeCount(page)).toBeGreaterThan(n0);
  // extrude and move is a single undo step
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(50);
  // 3 switches to segment selection mode
  await page.keyboard.press('3');
  expect(await get(page, 'app.doc.scene.tool_settings.gpencil_selectmode_edit')).toBe('SEGMENT');
  await page.keyboard.press('1');
  // Alt S scales the radius of the selected points
  const r0 = (await get(page, `${gp}.drawings[0].radius[0]`)) as number;
  await page.keyboard.press('Alt+s');
  await page.keyboard.type('2');
  await page.keyboard.press('Enter');
  expect(await get(page, `${gp}.drawings[0].radius[0]`)).toBeCloseTo(r0 * 2, 5);
  // M ▸ New Layer moves the selection to a new layer
  await page.keyboard.press('m');
  await expect(page.locator('.menu .menu-item', { hasText: 'New Layer' })).toBeVisible();
  await page.keyboard.press('Escape');
  // P separates the selection into a new object
  await hoverViewport(page);
  await page.keyboard.press('p');
  expect(await get(page, 'Object.keys(app.doc.objects).length')).toBe(2);
  await expectNoErrors(errors);
});

test('draw mode tools: curve primitive with handles, trim, box erase, eyedropper', async ({ page }) => {
  const errors = await openApp(page);
  await run(page, 'object.select_all', { action: 'SELECT' });
  await run(page, 'object.delete');
  await run(page, 'object.grease_pencil_add', { type: 'EMPTY' });
  await run(page, 'object.mode_set', { mode: 'PAINT_GREASE_PENCIL' });
  await run(page, 'view3d.view_axis', { type: 'FRONT' });
  const c = await hoverViewport(page);
  const tool = (id: string) => page.locator(`.v3d-toolbar [data-tool="${id}"]`).dispatchEvent('pointerdown');
  // Curve: drag out, move a handle, confirm with Enter
  await tool('builtin.curve');
  await page.mouse.move(c.x - 150, c.y + 50);
  await page.mouse.down();
  await page.mouse.move(c.x + 150, c.y - 50, { steps: 6 });
  await page.mouse.up();
  expect(await get(page, 'app.modal?.label')).toBe('Grease Pencil Curve Shape');
  await page.mouse.move(c.x - 50, c.y + 16.7);
  await page.mouse.down();
  await page.mouse.move(c.x - 100, c.y - 150, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  expect(await strokeCount(page)).toBe(1);
  // the handle bent the stroke upwards: its highest point is well above both ends
  const zs = (await get(page, `Array.from(${gp}.drawings[0].position).filter((_, i) => i % 3 === 2)`)) as number[];
  expect(Math.max(...zs)).toBeGreaterThan(Math.max(zs[0], zs[zs.length - 1]) + 0.1);
  expect(zs.length).toBe(64); // 63 subdivisions + 1
  // Line across it, then Trim the part of the line left of the crossing
  await tool('builtin.line');
  await page.mouse.move(c.x, c.y - 200);
  await page.mouse.down();
  await page.mouse.move(c.x, c.y + 200, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.press('Enter');
  expect(await strokeCount(page)).toBe(2);
  await tool('builtin.trim');
  await page.mouse.move(c.x - 170, c.y + 120);
  await page.mouse.down();
  for (const [dx, dy] of [[-80, 120], [-80, -60], [-170, -60]]) await page.mouse.move(c.x + dx, c.y + dy, { steps: 3 });
  await page.mouse.up();
  // the curve lost its left part; the line is untouched
  expect(await strokeCount(page)).toBe(2);
  const zs2 = (await get(page, `Array.from(${gp}.drawings[0].position).filter((_, i) => i % 3 === 0)`)) as number[];
  expect(zs2.length).toBeLessThan(64 + 7);
  // Box erase (B) everything
  await hoverViewport(page);
  await page.keyboard.press('b');
  await page.mouse.move(c.x - 300, c.y - 250);
  await page.mouse.down();
  await page.mouse.move(c.x + 300, c.y + 250, { steps: 4 });
  await page.mouse.up();
  expect(await strokeCount(page)).toBe(0);
  // Eyedropper: Shift click samples a fill material from the (grey) background
  await tool('builtin.eyedropper');
  const mats0 = (await get(page, `${gp}.materials.length`)) as number;
  await page.keyboard.down('Shift');
  await page.mouse.click(c.x + 200, c.y + 150);
  await page.keyboard.up('Shift');
  expect(await get(page, `${gp}.materials.length`)).toBe(mats0 + 1);
  expect(await get(page, `app.doc.materials[${gp}.materials[app.activeObject.active_material_index]].grease_pencil.show_fill`)).toBe(true);
  await expectNoErrors(errors);
});

test('modifiers and visual effects tabs', async ({ page }) => {
  const errors = await openApp(page);
  await strokeObject(page, 'OBJECT');
  await page.locator('.rail-tab[data-tab="MODIFIER"]').first().click();
  await page.locator('.add-mod').first().dispatchEvent('pointerdown');
  // grease pencil modifiers only; mesh ones are not offered
  for (const cat of ['Edit', 'Generate', 'Deform', 'Color']) await expect(page.locator('.menu .menu-item', { hasText: cat }).first()).toBeVisible();
  await page.locator('.menu .menu-item', { hasText: 'Deform' }).first().hover();
  await expect(page.locator('.menu .menu-item', { hasText: 'Bevel' })).toHaveCount(0);
  await page.locator('.menu .menu-item', { hasText: 'Thickness' }).first().click();
  expect(await get(page, 'app.activeObject.modifiers.map((m) => m.type)')).toEqual(['GREASE_PENCIL_THICKNESS']);
  await expect(page.locator('.modifier .panel-body').first()).toContainText('Influence');
  // Apply bakes it into the strokes
  const r0 = (await get(page, `${gp}.drawings[0].radius[0]`)) as number;
  await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    a.activeObject.modifiers[0].thickness_factor = 2;
    a.run('object.modifier_apply', { modifier: a.activeObject.modifiers[0].id });
  });
  expect(await get(page, `${gp}.drawings[0].radius[0]`)).toBeCloseTo(r0 * 2, 5);
  expect(await get(page, 'app.activeObject.modifiers.length')).toBe(0);
  // Visual Effects tab
  await page.locator('.rail-tab[data-tab="SHADERFX"]').first().click();
  await page.locator('.add-mod').first().dispatchEvent('pointerdown');
  await page.locator('.menu .menu-item', { hasText: 'Glow' }).first().click();
  expect(await get(page, 'app.activeObject.shader_effects.map((f) => f.type)')).toEqual(['FX_GLOW']);
  await expect(page.locator('.modifier .panel-body').first()).toContainText('Glow Color');
  await page.waitForTimeout(200);
  await expectNoErrors(errors);
});

test('dope sheet (grease pencil): scale, mirror, copy / paste, select before current frame', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => (window as any).app.run('wm.read_homefile', { app_template: '2D_Animation' }, { invoke: false })); // eslint-disable-line @typescript-eslint/no-explicit-any
  await page.waitForTimeout(300);
  // keys on frames 1, 5, 9 of the active layer
  await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    a.setFrame(5);
    a.run('grease_pencil.insert_blank_frame', {}, { invoke: false });
    a.setFrame(9);
    a.run('grease_pencil.insert_blank_frame', {}, { invoke: false });
    a.setFrame(1);
  });
  const keys = () => get(page, `${gp}.layers[${gp}.active_layer_index].frames.map((f) => f.frame_number)`);
  expect(await keys()).toEqual([1, 5, 9]);
  const main = page.locator('.anim-main').first();
  const box = (await main.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press('a');
  // S: scale the timing ×2 around frame 1, typed by mouse (drag twice the distance)
  const fx = (f: number) => page.evaluate((n) => (window as any).app.hoverArea.editor.view.fx(n), f); // eslint-disable-line @typescript-eslint/no-explicit-any
  const x5 = (await fx(5)) + box.x,
    x9 = (await fx(9)) + box.x;
  await page.mouse.move(x5, box.y + box.height / 2);
  await page.keyboard.press('s');
  await page.mouse.move(x9, box.y + box.height / 2, { steps: 3 });
  await page.mouse.down();
  await page.mouse.up();
  expect(await keys()).toEqual([1, 9, 17]);
  // Ctrl M mirrors over the current frame (5)
  await page.evaluate(() => (window as any).app.setFrame(5)); // eslint-disable-line @typescript-eslint/no-explicit-any
  await page.keyboard.press('Control+m');
  expect(await keys()).toEqual([-7, 1, 9]);
  // [ selects the keys before the current frame; Ctrl C / Ctrl V paste them at frame 20
  await page.keyboard.press('[');
  expect(await get(page, `${gp}.layers[${gp}.active_layer_index].frames.map((f) => !!f.select)`)).toEqual([true, true, false]);
  await page.keyboard.press('Control+c');
  await page.evaluate(() => (window as any).app.setFrame(20)); // eslint-disable-line @typescript-eslint/no-explicit-any
  await page.keyboard.press('Control+v');
  expect(await keys()).toEqual([-7, 1, 9, 20, 28]);
  await expectNoErrors(errors);
});

test('vertex paint and weight paint modes', async ({ page }) => {
  const errors = await openApp(page);
  await strokeObject(page, 'OBJECT');
  await run(page, 'view3d.view_axis', { type: 'FRONT' });
  const c = await hoverViewport(page);
  await page.evaluate(() => (window as any).app.run('view3d.view_selected')); // eslint-disable-line @typescript-eslint/no-explicit-any
  // the mode menu offers the grease pencil modes
  await page.locator('.hdr-mode').first().dispatchEvent('pointerdown');
  for (const m of ['Edit Mode', 'Sculpt Mode', 'Draw Mode', 'Weight Paint', 'Vertex Paint']) await expect(page.locator('.menu .menu-item', { hasText: m }).first()).toBeVisible();
  await page.locator('.menu .menu-item', { hasText: 'Vertex Paint' }).first().click();
  expect(await get(page, 'app.doc.mode')).toBe('VERTEX_GREASE_PENCIL');
  const painted = () => get(page, `(() => { const g = ${gp}; const d = g.drawings[g.layers[1].frames[0].drawing]; return Array.from(d.vertex_color).filter((x, i) => i % 4 === 3 && x > 0).length; })()`);
  expect(await painted()).toBe(0);
  await page.mouse.move(c.x - 250, c.y + 20);
  await page.mouse.down();
  await page.mouse.move(c.x + 50, c.y - 20, { steps: 15 });
  await page.mouse.up();
  expect(await painted()).toBeGreaterThan(0);
  // Paint ▸ Reset Color Attribute
  await page.locator('.hdr-menu', { hasText: /^Paint$/ }).first().dispatchEvent('pointerdown');
  await page.locator('.menu .menu-item', { hasText: 'Reset Color Attribute' }).click();
  expect(await painted()).toBe(0);
  // Weight Paint: painting creates a group and weights
  await run(page, 'object.mode_set', { mode: 'WEIGHT_GREASE_PENCIL' });
  await hoverViewport(page);
  await page.mouse.move(c.x - 250, c.y + 20);
  await page.mouse.down();
  await page.mouse.move(c.x + 50, c.y - 20, { steps: 15 });
  await page.mouse.up();
  expect(await get(page, `${gp}.vertex_groups.map((g) => g.name)`)).toEqual(['Group']);
  expect(await get(page, `(() => { const g = ${gp}; const w = g.drawings[g.layers[1].frames[0].drawing].weights.Group; return Array.from(w).filter((x) => x > 0).length; })()`)).toBeGreaterThan(0);
  await expectNoErrors(errors);
});

test('fill tool closes small gaps with extension lines', async ({ page }) => {
  const errors = await openApp(page);
  await run(page, 'object.select_all', { action: 'SELECT' });
  await run(page, 'object.delete');
  await run(page, 'object.grease_pencil_add', { type: 'EMPTY' });
  await run(page, 'object.mode_set', { mode: 'PAINT_GREASE_PENCIL' });
  await run(page, 'view3d.view_axis', { type: 'FRONT' });
  await page.waitForTimeout(400); // the view turns smoothly
  const c = await hoverViewport(page);
  const r = c.box;
  // a "U" whose top is open by 40 px
  const cx = r.width / 2,
    cy = r.height / 2;
  const pts = [
    [cx - 100, cy - 60],
    [cx - 100, cy + 80],
    [cx + 100, cy + 80],
    [cx + 100, cy - 60],
    [cx + 20, cy - 60],
  ];
  const left = [
    [cx - 20, cy - 60],
    [cx - 100, cy - 60],
  ];
  await page.evaluate(([a, b]) => {
    const app = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    app.run('grease_pencil.draw_points', { points: JSON.stringify(a.map(([x, y]: number[]) => [x, y, 1])) }, { invoke: false });
    app.run('grease_pencil.draw_points', { points: JSON.stringify(b.map(([x, y]: number[]) => [x, y, 1])) }, { invoke: false });
  }, [pts, left]);
  expect(await strokeCount(page)).toBe(2);
  const fill = () => page.evaluate(([x, y]) => (window as any).app.run('grease_pencil.fill', { x, y }, { invoke: false }), [cx, cy]); // eslint-disable-line @typescript-eslint/no-explicit-any
  await fill();
  expect(await strokeCount(page)).toBe(2);
  // close the 40 px gap
  await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const b = a.doc.scene.tool_settings.gpencil_brushes['builtin.brush.Fill'];
    b.fill_extend = 3; // about 90 px at this zoom
    b.fill_extend_mode = 'RADIUS';
  });
  await fill();
  expect(await strokeCount(page)).toBe(3);
  await expectNoErrors(errors);
});

test('edit mode: proportional editing moves nearby points', async ({ page }) => {
  const errors = await openApp(page);
  await run(page, 'object.select_all', { action: 'SELECT' });
  await run(page, 'object.delete');
  await run(page, 'object.grease_pencil_add', { type: 'EMPTY' });
  await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const g = a.doc.grease_pencils[a.activeObject.data];
    const d = g.drawings[g.layers[0].frames[0].drawing];
    const xs = [0, 0.5, 1, 1.5, 3];
    const n = xs.length;
    g.drawings[g.layers[0].frames[0].drawing] = {
      ...d,
      position: new Float32Array(xs.flatMap((x) => [x, 0, 0])),
      radius: new Float32Array(n).fill(0.02),
      opacity: new Float32Array(n).fill(1),
      vertex_color: new Float32Array(n * 4),
      select: new Uint8Array([1, 0, 0, 0, 0]),
      offsets: new Uint32Array([0, n]),
      cyclic: new Uint8Array(1),
      material_index: new Uint16Array(1),
      start_cap: new Uint8Array(1),
      end_cap: new Uint8Array(1),
      fill_color: new Float32Array(4),
      fill_opacity: new Float32Array([1]),
      fill_id: new Int32Array(1),
    };
    const ts = a.doc.scene.tool_settings;
    ts.proportional_size = 1;
    ts.proportional_edit_falloff = 'LINEAR';
    a.run('object.mode_set', { mode: 'EDIT' });
  });
  await hoverViewport(page);
  await page.keyboard.press('o');
  expect(await get(page, 'app.doc.scene.tool_settings.use_proportional_edit')).toBe(true);
  await page.keyboard.press('g');
  await page.keyboard.press('z');
  await page.keyboard.type('1');
  await page.keyboard.press('Enter');
  const z = (await get(page, `Array.from(${gp}.drawings[0].position).filter((_, i) => i % 3 === 2).map((v) => Math.round(v * 100) / 100)`)) as number[];
  expect(z).toEqual([1, 0.5, 0, 0, 0]);
  await expectNoErrors(errors);
});
