// Object Mode menus, shortcuts and Object Data list wiring.
import { test, expect, type Page } from '@playwright/test';
import { openApp, hoverViewport, expectNoErrors } from './helpers';

const get = (page: Page, expr: string) => page.evaluate(`(() => { const app = window.app; return ${expr}; })()`);
const run = (page: Page, op: string, props: Record<string, unknown> = {}) => page.evaluate(([o, p]) => (window as any).app.run(o, p, { invoke: false }), [op, props] as const); // eslint-disable-line @typescript-eslint/no-explicit-any
const item = (page: Page, text: string) => page.locator('.menu-item', { hasText: text });

async function headerMenu(page: Page, label: string) {
  await page.locator('.hdr-menu', { hasText: new RegExp(`^${label}$`) }).first().dispatchEvent('pointerdown');
  await expect(page.locator('.menu-item').first()).toBeVisible();
}

test('object menu structure and shortcuts open the right menus', async ({ page }) => {
  const errors = await openApp(page);
  await headerMenu(page, 'Object');
  for (const label of ['Set Origin', 'Apply', 'Collection', 'Relations', 'Parent', 'Modifiers', 'Link/Transfer Data', 'Convert', 'Clean Up', 'Delete Global']) await expect(item(page, label).first()).toBeVisible();
  await item(page, 'Apply').first().hover();
  await expect(item(page, 'Rotation to Deltas')).toBeVisible();
  await expect(item(page, 'Animated Transforms to Deltas')).toBeVisible();
  await page.keyboard.press('Escape');

  await hoverViewport(page);
  // Ctrl L: link/transfer data
  await page.keyboard.press('Control+l');
  await expect(item(page, 'Transfer Mesh Data').first()).toBeVisible();
  await expect(item(page, 'Copy UV Maps').first()).toBeVisible();
  await page.keyboard.press('Escape');
  // Shift G: select grouped
  await page.keyboard.press('Shift+g');
  await expect(item(page, 'Immediate Children').first()).toBeVisible();
  await page.keyboard.press('Escape');
  // Ctrl P: parent types
  await page.keyboard.press('Control+p');
  await expect(item(page, 'Object (Keep Transform)').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expectNoErrors(errors);
});

test('select more/less shortcuts follow parent links', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      a.run('object.empty_add', { location: [i, 0, 0] }, { invoke: false });
      if (ids.length) a.activeObject.parent = ids[ids.length - 1];
      ids.push(a.activeObject.id);
    }
    a.run('object.select_all', { action: 'DESELECT' });
    a.doc.objects[ids[1]].select = true;
    (window as any).chain = ids; // eslint-disable-line @typescript-eslint/no-explicit-any
    a.changed('doc', 'select');
  });
  const selected = () => get(page, `window.chain.filter((id) => app.doc.objects[id].select).length`);
  await hoverViewport(page);
  await page.keyboard.press('Control+NumpadAdd');
  expect(await selected()).toBe(3);
  await page.evaluate(() => ((window as any).app.doc.objects[(window as any).chain[0]].select = false)); // eslint-disable-line @typescript-eslint/no-explicit-any
  await page.keyboard.press('Control+NumpadSubtract');
  expect(await selected()).toBe(1);
  await expectNoErrors(errors);
});

test('vertex group and shape key lists: specials menus, move buttons, locks', async ({ page }) => {
  const errors = await openApp(page);
  await run(page, 'object.vertex_group_add');
  await run(page, 'object.vertex_group_add');
  await page.locator('.rail-tab[data-tab="DATA"]').first().click();
  const vg = page.locator('.panel', { hasText: 'Vertex Groups' }).first();
  await expect(vg.locator('.ul-row')).toHaveCount(2);
  // specials ▸ Copy Vertex Group
  await vg.locator('.ul-specials').dispatchEvent('pointerdown');
  await item(page, 'Copy Vertex Group').first().click();
  await expect(vg.locator('.ul-row')).toHaveCount(3);
  expect(await get(page, `app.doc.meshes[app.activeObject.data].vertex_groups.map((g) => g.name).join(',')`)).toBe('Group,Group.001,Group.001_copy');
  // move up
  await vg.locator('[data-tip="Move Up"]').click();
  expect(await get(page, `app.activeObject.vertex_group_active_index`)).toBe(1);
  // lock toggle on a row
  await vg.locator('.ul-lock').first().click();
  expect(await get(page, `app.doc.meshes[app.activeObject.data].vertex_groups[0].lock_weight`)).toBe(true);

  await run(page, 'object.shape_key_add');
  await run(page, 'object.shape_key_add');
  const sk = page.locator('.panel', { hasText: 'Shape Keys' }).first();
  await expect(sk.locator('.ul-row')).toHaveCount(2);
  await sk.locator('.ul-specials').dispatchEvent('pointerdown');
  await item(page, 'Duplicate Shape Key').first().click();
  await expect(sk.locator('.ul-row')).toHaveCount(3);
  await expectNoErrors(errors);
});

test('add menu collection instance draws the collection', async ({ page }) => {
  const errors = await openApp(page);
  await run(page, 'collection.create', { name: 'Kit' });
  await hoverViewport(page);
  await page.keyboard.press('Shift+a');
  await item(page, 'Collection Instance').first().hover();
  await item(page, 'Kit').last().click();
  await page.waitForTimeout(300);
  const count = await page.evaluate(async () => {
    const { renderContext } = await import('/src/render/context.ts');
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const so = renderContext.sync.objects.get(a.activeObject.id);
    return so?.duplis?.children.length ?? 0;
  });
  expect(await get(page, `app.activeObject.instance_type`)).toBe('COLLECTION');
  expect(count).toBe(1);
  await expectNoErrors(errors);
});

test('interactive mirror and the vertex weights panel', async ({ page }) => {
  const errors = await openApp(page);
  await run(page, 'transform.translate', { value: [2, 0, 0] });
  await page.evaluate(() => ((window as any).app.activeObject.location = [2, 0, 0])); // eslint-disable-line @typescript-eslint/no-explicit-any
  await run(page, 'object.empty_add', { location: [4, 0, 0] });
  await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    for (const o of Object.values(a.doc.objects) as any[]) o.select = o.name === 'Cube' || o.name === 'Empty'; // eslint-disable-line @typescript-eslint/no-explicit-any
    a.changed('doc', 'select');
  });
  await hoverViewport(page);
  await page.keyboard.press('Control+m');
  await page.keyboard.press('x');
  await page.keyboard.press('Enter');
  // mirrored around the selection centre (x = 3)
  expect(await get(page, `app.doc.objects[Object.keys(app.doc.objects).find((k) => app.doc.objects[k].name === 'Cube')].location[0].toFixed(3)`)).toBe('4.000');
  expect(await get(page, `app.doc.objects[Object.keys(app.doc.objects).find((k) => app.doc.objects[k].name === 'Empty')].location[0].toFixed(3)`)).toBe('2.000');
  await page.keyboard.press('Control+z');

  // vertex weights panel in Edit Mode
  await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    a.run('object.select_all', { action: 'DESELECT' });
    const cube = Object.values(a.doc.objects).find((o: any) => o.name === 'Cube') as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    cube.select = true;
    a.doc.scene.active_object = cube.id;
    a.run('object.vertex_group_add', {}, { invoke: false });
    const me = a.doc.meshes[cube.data];
    me.weights[0] = new Float32Array(8).fill(0.5);
    a.run('object.mode_set', { mode: 'EDIT' }, { invoke: false });
    me.select_vert = Uint8Array.from([1, 1, 0, 0, 0, 0, 0, 0]);
    a.changed('doc', 'select');
  });
  await hoverViewport(page);
  await page.keyboard.press('n');
  await page.locator('.sb-tab', { hasText: 'Item' }).first().click();
  await expect(page.locator('.vw-row')).toHaveCount(1);
  await page.locator('.vw-row [data-tip="Delete weight"]').click();
  expect(await get(page, `app.doc.meshes[app.activeObject.data].weights[0][0]`)).toBe(0);
  await expectNoErrors(errors);
});

test('convert text to a curve', async ({ page }) => {
  const errors = await openApp(page);
  await run(page, 'object.text_add', { location: [0, 0, 0] });
  await page.waitForFunction(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    return (a.graph.get(a.activeObject.id)?.mesh?.indices.length ?? 0) > 0;
  });
  await run(page, 'object.convert', { target: 'CURVE' });
  expect(await get(page, `app.activeObject.type`)).toBe('CURVE');
  expect(await get(page, `app.doc.curves[app.activeObject.data].splines.length > 0`)).toBe(true);
  await expectNoErrors(errors);
});

test('modifier panel shortcuts act on the hovered modifier', async ({ page }) => {
  const errors = await openApp(page);
  await run(page, 'object.modifier_add', { type: 'SUBSURF' });
  await page.locator('.rail-tab[data-tab="MODIFIER"]').first().click();
  const panel = page.locator('.panel.modifier').first();
  await expect(panel).toBeVisible();
  const box = (await panel.locator('.mod-header').boundingBox())!;
  await page.mouse.move(box.x + box.width - 60, box.y + box.height / 2);
  await page.keyboard.press('Shift+d');
  expect(await get(page, `app.activeObject.modifiers.length`)).toBe(2);
  await page.mouse.move(box.x + box.width - 60, box.y + box.height / 2);
  await page.keyboard.press('x');
  expect(await get(page, `app.activeObject.modifiers.length`)).toBe(1);
  await page.keyboard.press('Shift+a');
  await expect(item(page, 'Deform').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expectNoErrors(errors);
});

test('speaker: add, give it a sound, it plays during playback', async ({ page }) => {
  const errors = await openApp(page);
  await hoverViewport(page);
  await page.keyboard.press('Shift+a');
  await item(page, 'Speaker').first().click();
  expect(await get(page, `app.activeObject.type`)).toBe('SPEAKER');
  // a short generated tone as the sound
  await page.evaluate(() => {
    const rate = 8000,
      n = rate;
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF');
    v.setUint32(4, 36 + n * 2, true);
    str(8, 'WAVEfmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, rate, true);
    v.setUint32(28, rate * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    str(36, 'data');
    v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin(i / 4) * 8000, true);
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    a.activeObject.speaker.sound = { filepath: 'tone.wav', mime: 'audio/wav', bytes: new Uint8Array(buf) };
    a.changed('doc');
  });
  await page.locator('.rail-tab[data-tab="DATA"]').first().click();
  await expect(page.locator('.panel', { hasText: 'Sound' }).first()).toContainText('tone.wav');
  await run(page, 'screen.animation_play');
  await page.waitForFunction(async () => (await import('/src/object/speaker.ts')).speakerVoiceCount() > 0, null, { timeout: 5000 });
  await run(page, 'screen.animation_play');
  // the speaker is part of rendered audio
  const peak = await page.evaluate(async () => {
    const { mixdown, hasSound } = await import('/src/sequencer/audio.ts');
    if (!hasSound(null)) return -1;
    const buf = await mixdown(null, 24, 1, 13);
    return Math.max(...Array.from(buf.getChannelData(0)).map(Math.abs));
  });
  expect(peak).toBeGreaterThan(0.01);
  await expectNoErrors(errors);
});

test('shift T aims the selection at the surface under the mouse', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const light = Object.values(a.doc.objects).find((o: any) => o.type === 'LIGHT') as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    a.run('object.select_all', { action: 'DESELECT' });
    light.select = true;
    light.rotation_euler = [0, 0, 0];
    a.doc.scene.active_object = light.id;
    a.changed('doc', 'select');
  });
  const c = await hoverViewport(page);
  await page.keyboard.press('Shift+t');
  await page.mouse.move(c.x + 5, c.y + 5);
  await page.mouse.down();
  await page.mouse.up();
  const rot = (await get(page, `app.activeObject.rotation_euler`)) as number[];
  expect(rot.some((r) => Math.abs(r) > 0.01)).toBe(true);
  await expectNoErrors(errors);
});
