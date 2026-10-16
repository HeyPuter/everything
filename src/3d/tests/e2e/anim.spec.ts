import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors, openHeaderMenu } from './helpers';

/** Key the cube's X location and turn the 3D view into the given animation editor. */
async function setup(page: Page, editor: 'GRAPH' | 'DOPESHEET' | 'NLA', vals = [0, 1, 3, 2, 5, 4, 6, 2, 0], sel = [2, 3, 4, 5, 6]) {
  await page.evaluate(
    async ([editor, vals, sel]) => {
      const { shell } = await import('/src/ui/shell.ts');
      const { keyProperty } = await import('/src/anim/keyframes.ts');
      const app = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
      const ob = app.activeObject;
      (vals as number[]).forEach((v, i) => {
        ob.location[0] = v;
        keyProperty(app.doc, ob, 'location', 0, 1 + i * 5);
      });
      const fc = app.doc.actions[ob.animation_data.action].fcurves[0];
      fc.keyframe_points.forEach((k: any, i: number) => { // eslint-disable-line @typescript-eslint/no-explicit-any
        const s = (sel as number[]).includes(i);
        k.select_control_point = s;
        k.select_left_handle = s;
        k.select_right_handle = s;
      });
      app.pushUndo('Setup');
      shell.screen.areas.find((a: { type: string }) => a.type === 'VIEW_3D').setType(editor);
      app.changed('doc');
    },
    [editor, vals, sel] as const,
  );
  await page.waitForTimeout(300);
  const box = (await area(page, editor).locator('.anim-main canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  return box;
}

/** The area showing an editor type. */
const area = (page: Page, type: string) => page.locator(`.area[data-editor="${type}"]`).first();

const keyValues = (page: Page) =>
  page.evaluate(() => {
    const app = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const ob = app.activeObject;
    return app.doc.actions[ob.animation_data.action].fcurves[0].keyframe_points.map((k: { co: number[] }) => Math.round(k.co[1] * 1000) / 1000);
  });

test('graph editor: blend slider from the Key menu, then adjust it from the redo panel', async ({ page }) => {
  const errors = await openApp(page);
  const box = await setup(page, 'GRAPH');
  await openHeaderMenu(page, area(page, 'GRAPH'), /^Key$/);
  await page.locator('.menu-item', { hasText: /^Blend/ }).first().hover();
  await page.locator('.menu-item', { hasText: 'Blend to Neighbor' }).click();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 4 });
  await page.mouse.down();
  await page.mouse.up();
  const after = await keyValues(page);
  expect(after).not.toEqual([0, 1, 3, 2, 5, 4, 6, 2, 0]);
  expect(await page.evaluate(() => (window as any).app.lastOp?.idname)).toBe('graph.blend_to_neighbor'); // eslint-disable-line @typescript-eslint/no-explicit-any
  // Adjust Last Operation re-runs on the previous state
  await page.evaluate(() => (window as any).app.redoLast({ factor: 0.5 })); // eslint-disable-line @typescript-eslint/no-explicit-any
  await page.waitForTimeout(100);
  expect(await keyValues(page)).toEqual([0, 1, 2.5, 2, 3.5, 3, 4, 2, 0]);
  await expectNoErrors(errors);
});

test('graph editor: smoothing, density and blend shortcuts', async ({ page }) => {
  const errors = await openApp(page);
  await setup(page, 'GRAPH');
  await page.keyboard.press('Alt+S');
  await expect(page.locator('.menu-item', { hasText: 'Butterworth Smooth' })).toBeVisible();
  await page.locator('.menu-item', { hasText: 'Smooth (Legacy)' }).click();
  expect((await keyValues(page)).slice(2, 7)).toEqual([3, 3.5, 3.833, 4.75, 6]);
  await page.keyboard.press('Alt+D');
  await expect(page.locator('.menu-item', { hasText: 'Scale from Neighbor' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Shift+Alt+O');
  expect((await keyValues(page)).length).toBe(25);
  await expectNoErrors(errors);
});

test('graph editor: circle select, select key handles and euler filter entries', async ({ page }) => {
  const errors = await openApp(page);
  const box = await setup(page, 'GRAPH', [0, 1, 3, 2, 5, 4, 6, 2, 0], []);
  await page.keyboard.press('Home');
  await page.keyboard.press('C');
  await page.mouse.move(box.x + 5, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 5, box.y + box.height / 2, { steps: 30 });
  await page.mouse.up();
  await page.mouse.click(box.x + 20, box.y + 40, { button: 'right' });
  const selected = await page.evaluate(() => {
    const app = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const ob = app.activeObject;
    return app.doc.actions[ob.animation_data.action].fcurves[0].keyframe_points.filter((k: { select_control_point: boolean }) => k.select_control_point).length;
  });
  expect(selected).toBeGreaterThan(0);
  await openHeaderMenu(page, area(page, 'GRAPH'), 'Select');
  await expect(page.locator('.menu-item', { hasText: 'Select Handles' })).toBeVisible();
  await page.keyboard.press('Escape');
  await openHeaderMenu(page, area(page, 'GRAPH'), 'Channel');
  await expect(page.locator('.menu-item', { hasText: 'Discontinuity (Euler) Filter' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expectNoErrors(errors);
});

test('markers: add, select, rename, camera bind and delete', async ({ page }) => {
  const errors = await openApp(page);
  await setup(page, 'DOPESHEET');
  await page.keyboard.press('M');
  expect(await page.evaluate(() => (window as any).app.doc.scene.timeline_markers.map((m: { name: string }) => m.name))).toEqual(['F_01']); // eslint-disable-line @typescript-eslint/no-explicit-any
  // jump and add another, then bind the camera there
  await page.evaluate(() => {
    const app = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    app.setFrame(20);
  });
  await page.keyboard.press('Control+B');
  const ms = await page.evaluate(() => (window as any).app.doc.scene.timeline_markers.map((m: { frame: number; camera?: string }) => [m.frame, !!m.camera])); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(ms).toEqual([
    [1, false],
    [20, true],
  ]);
  // marker row: select all with A, delete with X
  const box = (await area(page, 'DOPESHEET').locator('.anim-main canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 8);
  await page.keyboard.press('A');
  expect(await page.evaluate(() => (window as any).app.doc.scene.timeline_markers.every((m: { select: boolean }) => m.select))).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any
  await openHeaderMenu(page, area(page, 'DOPESHEET'), 'Marker');
  await expect(page.locator('.menu-item', { hasText: 'Bind Camera to Markers' })).toBeVisible();
  await page.locator('.menu-item', { hasText: 'Delete Marker' }).click();
  expect(await page.evaluate(() => (window as any).app.doc.scene.timeline_markers.length)).toBe(0); // eslint-disable-line @typescript-eslint/no-explicit-any
  await expectNoErrors(errors);
});

test('channels: reorder, editability toggle and preview range', async ({ page }) => {
  const errors = await openApp(page);
  await setup(page, 'GRAPH');
  await page.evaluate(async () => {
    const { keyProperty } = await import('/src/anim/keyframes.ts');
    const app = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    keyProperty(app.doc, app.activeObject, 'scale', -1, 1);
    const act = app.doc.actions[app.activeObject.animation_data.action];
    act.fcurves.forEach((f: { select: boolean; data_path: string; array_index: number }) => (f.select = f.data_path === 'scale' && f.array_index === 2));
    app.pushUndo('more');
    app.changed('doc');
  });
  await page.waitForTimeout(200);
  const ch = (await area(page, 'GRAPH').locator('.anim-ch-rows').boundingBox())!;
  await page.mouse.move(ch.x + 40, ch.y + 10);
  await page.keyboard.press('Shift+PageUp');
  const order = await page.evaluate(() => {
    const app = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    return app.doc.actions[app.activeObject.animation_data.action].fcurves.filter((f: { group?: string }) => f.group).map((f: { data_path: string; array_index: number }) => `${f.data_path}${f.array_index}`);
  });
  expect(order.indexOf('scale2')).toBeLessThan(order.indexOf('scale0'));
  await page.keyboard.press('Tab');
  expect(
    await page.evaluate(() => {
      const app = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
      return app.doc.actions[app.activeObject.animation_data.action].fcurves.find((f: { select: boolean }) => f.select).lock;
    }),
  ).toBe(true);
  // P + drag sets the preview range
  const box = (await area(page, 'GRAPH').locator('.anim-main canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press('P');
  await page.mouse.move(box.x + 100, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + 300, box.y + 100, { steps: 3 });
  await page.mouse.up();
  const s = await page.evaluate(() => {
    const sc = (window as any).app.doc.scene; // eslint-disable-line @typescript-eslint/no-explicit-any
    return [sc.use_preview_range, sc.frame_preview_start < sc.frame_preview_end];
  });
  expect(s).toEqual([true, true]);
  await page.keyboard.press('Alt+P');
  expect(await page.evaluate(() => (window as any).app.doc.scene.use_preview_range)).toBe(false); // eslint-disable-line @typescript-eslint/no-explicit-any
  await expectNoErrors(errors);
});

test('pose mode: in-between slider, propagate, names and selection sets', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(async () => {
    const app = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const { keyProperty } = await import('/src/anim/keyframes.ts');
    app.run('object.armature_add', {}, { invoke: false });
    const ob = app.activeObject;
    const arm = app.doc.armatures[ob.data];
    arm.bones.push({ ...structuredClone(arm.bones[0]), name: 'Arm.L', parent: arm.bones[0].name, head: [0.5, 0, 1], tail: [1, 0, 1] });
    arm.bones.push({ ...structuredClone(arm.bones[0]), name: 'Arm.R', parent: arm.bones[0].name, head: [-0.5, 0, 1], tail: [-1, 0, 1] });
    app.run('object.posemode_toggle', {}, { invoke: false });
    const pose = app.activeObject.pose;
    for (const n of Object.keys(pose)) pose[n].select = n === 'Arm.L';
    arm.active_bone = 'Arm.L';
    pose['Arm.L'].location = [0, 0, 0];
    keyProperty(app.doc, ob, 'pose.bones["Arm.L"].location', -1, 1);
    pose['Arm.L'].location = [2, 0, 4];
    keyProperty(app.doc, ob, 'pose.bones["Arm.L"].location', -1, 21);
    app.setFrame(11);
    app.flush();
    pose['Arm.L'].location = [5, 0, 0];
    app.pushUndo('setup');
    app.changed('doc');
  });
  const vp = (await page.locator('.view3d').first().boundingBox())!;
  await page.mouse.move(vp.x + vp.width / 2, vp.y + vp.height / 2);
  await page.keyboard.press('Shift+E');
  expect(await page.evaluate(() => (window as any).app.modal?.label)).toBe('Pose Breakdowner'); // eslint-disable-line @typescript-eslint/no-explicit-any
  await page.keyboard.press('Enter');
  // breakdown at 50% between (0,0,0) and (2,0,4)
  expect(await page.evaluate(() => (window as any).app.activeObject.pose['Arm.L'].location)).toEqual([1, 0, 2]); // eslint-disable-line @typescript-eslint/no-explicit-any
  // propagate to the next key
  await page.keyboard.press('Alt+P');
  await page.locator('.menu-item', { hasText: 'To Next Keyframe' }).click();
  const k21 = await page.evaluate(() => {
    const app = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const fc = app.doc.actions[app.activeObject.animation_data.action].fcurves.find((f: { data_path: string; array_index: number }) => f.data_path.endsWith('.location') && f.array_index === 2);
    return fc.keyframe_points[1].co[1];
  });
  expect(k21).toBeCloseTo(2, 5);
  // select mirror, flip names, selection set
  await page.keyboard.press('Shift+Control+M');
  expect(await page.evaluate(() => (window as any).app.activeObject.pose['Arm.R'].select)).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any
  await openHeaderMenu(page, area(page, 'VIEW_3D'), 'Pose');
  await page.locator('.menu-item', { hasText: 'Selection Sets' }).hover();
  await page.locator('.menu-item', { hasText: 'Create and Add Selected' }).click();
  expect(await page.evaluate(() => (window as any).app.activeObject.selection_sets[0].bones)).toEqual(['Arm.R']); // eslint-disable-line @typescript-eslint/no-explicit-any
  await page.keyboard.press('A');
  await openHeaderMenu(page, area(page, 'VIEW_3D'), 'Pose');
  await page.locator('.menu-item', { hasText: 'Names' }).hover();
  await page.locator('.menu-item', { hasText: 'Flip Names' }).click();
  const names = await page.evaluate(() => {
    const app = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    return app.doc.armatures[app.activeObject.data].bones.map((b: { name: string }) => b.name);
  });
  expect(names).toEqual(['Bone', 'Arm.R', 'Arm.L']);
  await expectNoErrors(errors);
});

test('NLA: tweak mode, meta strips, transitions and strip menu', async ({ page }) => {
  const errors = await openApp(page);
  await setup(page, 'NLA');
  await page.evaluate(async () => {
    const app = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const { pushDown, copyAction, makeStrip } = await import('/src/animation/actionops.ts');
    const ob = app.activeObject;
    const act = app.doc.actions[ob.animation_data.action];
    const strip = pushDown(app.doc, ob);
    strip.select = true;
    const b = copyAction(app.doc, act);
    const s2 = makeStrip(b, 80);
    ob.animation_data.nla_tracks[0].strips.push(s2);
    app.pushUndo('nla setup');
    app.changed('doc');
  });
  await page.waitForTimeout(200);
  const box = (await area(page, 'NLA').locator('.anim-main canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press('Shift+T');
  const types = () =>
    page.evaluate(() => (window as any).app.activeObject.animation_data.nla_tracks[0].strips.map((s: { type?: string }) => s.type ?? 'CLIP')); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(await types()).toEqual(['CLIP', 'TRANSITION', 'CLIP']);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(100);
  await page.keyboard.press('Control+G');
  expect(await types()).toEqual(['META']);
  await page.keyboard.press('Control+Alt+G');
  expect(await types()).toEqual(['CLIP', 'CLIP']);
  // tweak the active strip
  await page.evaluate(() => {
    const app = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const strips = app.activeObject.animation_data.nla_tracks[0].strips;
    strips.forEach((s: { select: boolean }, i: number) => (s.select = i === 0));
    app.changed('doc');
  });
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!(window as any).app.activeObject.animation_data.tweak)).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any
  await expect(area(page, 'NLA').locator('.hdr-toggle', { hasText: 'Tweaking' })).toBeVisible();
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!(window as any).app.activeObject.animation_data.tweak)).toBe(false); // eslint-disable-line @typescript-eslint/no-explicit-any
  await openHeaderMenu(page, area(page, 'NLA'), 'Strip');
  for (const label of ['Make Meta', 'Linked Duplicate', 'Apply Scale', 'Make Single User', 'Start Tweaking Strip Actions (Full Stack)']) await expect(page.locator('.menu-item', { hasText: label }).first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expectNoErrors(errors);
});

test('timeline: summary keys can be selected and moved, ruler scrubs, markers', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(async () => {
    const app = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const { keyProperty } = await import('/src/anim/keyframes.ts');
    const ob = app.activeObject;
    [0, 1, 3].forEach((v: number, i: number) => {
      ob.location[0] = v;
      keyProperty(app.doc, ob, 'location', -1, 1 + i * 20);
    });
    for (const fc of app.doc.actions[ob.animation_data.action].fcurves) fc.keyframe_points.forEach((k: { select_control_point: boolean }) => (k.select_control_point = false));
    app.pushUndo('keys');
    app.changed('doc');
  });
  await page.waitForTimeout(200);
  const tl = page.locator('.timeline-ed canvas');
  const box = (await tl.boundingBox())!;
  // scrub on the ruler
  await page.mouse.click(box.x + box.width / 2, box.y + 8);
  expect(await page.evaluate(() => (window as any).app.doc.scene.frame_current)).toBeGreaterThan(20); // eslint-disable-line @typescript-eslint/no-explicit-any
  // select all keys and move them 5 frames
  await page.mouse.move(box.x + box.width / 2, box.y + 28);
  await page.keyboard.press('A');
  await page.keyboard.press('G');
  await page.keyboard.type('5');
  await page.keyboard.press('Enter');
  const frames = await page.evaluate(() => {
    const app = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    return app.doc.actions[app.activeObject.animation_data.action].fcurves[0].keyframe_points.map((k: { co: number[] }) => k.co[0]);
  });
  expect(frames).toEqual([6, 26, 46]);
  await page.keyboard.press('M');
  expect(await page.evaluate(() => (window as any).app.doc.scene.timeline_markers.length)).toBe(1); // eslint-disable-line @typescript-eslint/no-explicit-any
  await expectNoErrors(errors);
});

test('keying sets: add a property from its decorator menu, then insert keys with the set', async ({ page }) => {
  const errors = await openApp(page);
  // Object properties: right-click the Location Z decorator
  const deco = page.locator('.split-row', { hasText: 'Z' }).locator('.decorator').first();
  await deco.click({ button: 'right' });
  await page.locator('.menu-item', { hasText: 'Add Single to Keying Set' }).click();
  const ks = await page.evaluate(() => {
    const s = (window as any).app.doc.scene; // eslint-disable-line @typescript-eslint/no-explicit-any
    return [s.keying_set, s.keying_sets.map((k: { name: string; paths: { data_path: string; index: number }[] }) => [k.name, k.paths.map((p) => `${p.data_path}[${p.index}]`)])];
  });
  expect(ks).toEqual(['KS:Button Keying Set', [['Button Keying Set', ['location[2]']]]]);
  // the Scene tab lists the set and its path
  await page.locator('.rail-tab[data-tab="SCENE"]').click();
  await expect(page.locator('.uilist', { hasText: 'Button Keying Set' })).toBeVisible();
  // I in the viewport inserts keys for the set's paths only
  const vp = (await page.locator('.view3d').first().boundingBox())!;
  await page.mouse.move(vp.x + vp.width / 2, vp.y + vp.height / 2);
  await page.keyboard.press('I');
  const curves = await page.evaluate(() => {
    const app = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const act = app.doc.actions[app.activeObject.animation_data.action];
    return act.fcurves.map((f: { data_path: string; array_index: number }) => `${f.data_path}[${f.array_index}]`);
  });
  expect(curves).toEqual(['location[2]']);
  await expectNoErrors(errors);
});

test('property menu: copy/paste driver, view curve in the Graph Editor; select keys by type', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(async () => {
    const app = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const { keyProperty } = await import('/src/anim/keyframes.ts');
    keyProperty(app.doc, app.activeObject, 'location', 2, 1);
    app.run('anim.driver_button_add', { object: app.activeObject.id, data_path: 'scale', index: 0 }, { invoke: false });
    app.run('anim.copy_driver_button', { object: app.activeObject.id, data_path: 'scale', index: 0 }, { invoke: false });
    app.run('anim.paste_driver_button', { object: app.activeObject.id, data_path: 'scale', index: 1 }, { invoke: false });
    app.changed('doc');
  });
  expect(await page.evaluate(() => (window as any).app.activeObject.animation_data.drivers.map((d: { array_index: number }) => d.array_index))).toEqual([0, 1]); // eslint-disable-line @typescript-eslint/no-explicit-any
  const deco = page.locator('.split-row', { hasText: 'Z' }).locator('.decorator').first();
  await deco.click({ button: 'right' });
  await page.locator('.menu-item', { hasText: 'View in Graph Editor' }).click();
  await expect(page.locator('.area[data-editor="GRAPH"]')).toHaveCount(1);
  // the Dope Sheet's Select ▸ Select By Type
  await page.evaluate(async () => {
    const { shell } = await import('/src/ui/shell.ts');
    shell.screen.areas.find((a: { type: string }) => a.type === 'GRAPH').setType('DOPESHEET');
  });
  await openHeaderMenu(page, area(page, 'DOPESHEET'), 'Select');
  await page.locator('.menu-item', { hasText: 'Select By Type' }).hover();
  await expect(page.locator('.menu-item', { hasText: 'Breakdown' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expectNoErrors(errors);
});

test('proportional editing of keys: O toggles, G moves neighbours partly', async ({ page }) => {
  const errors = await openApp(page);
  const box = await setup(page, 'DOPESHEET', [0, 0, 0, 0, 0], [2]);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press('O');
  expect(await page.evaluate(() => (window as any).app.doc.scene.tool_settings.use_proportional_action)).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any
  await page.evaluate(() => ((window as any).app.doc.scene.tool_settings.proportional_size = 8)); // eslint-disable-line @typescript-eslint/no-explicit-any
  await page.keyboard.press('G');
  await page.keyboard.type('4');
  await page.keyboard.press('Enter');
  const frames = await page.evaluate(() => {
    const app = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    return app.doc.actions[app.activeObject.animation_data.action].fcurves[0].keyframe_points.map((k: { co: number[] }) => Math.round(k.co[0] * 100) / 100);
  });
  expect(frames[2]).toBe(15);
  expect(frames[1]).toBeGreaterThan(6);
  expect(frames[1]).toBeLessThan(10);
  expect(frames[0]).toBe(1);
  await expectNoErrors(errors);
});

/** A short mono 16-bit WAV: a tone for `on` seconds, then silence. */
function wav(seconds: number, on: number, rate = 8000) {
  const n = Math.round(seconds * rate);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(i < on * rate ? Math.round(20000 * Math.sin((2 * Math.PI * 220 * i) / rate)) : 0, 44 + i * 2);
  return buf;
}

test('graph editor: sound to samples bakes an audio envelope', async ({ page }) => {
  const errors = await openApp(page);
  await setup(page, 'GRAPH');
  await page.evaluate(() => {
    const app = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    app.doc.actions[app.activeObject.animation_data.action].fcurves[0].select = true;
    app.changed('doc');
  });
  const chooser = page.waitForEvent('filechooser');
  await openHeaderMenu(page, area(page, 'GRAPH'), 'Channel');
  await page.locator('.menu-item', { hasText: 'Sound to Samples' }).click();
  await (await chooser).setFiles({ name: 'tone.wav', mimeType: 'audio/wav', buffer: wav(1, 0.5) });
  await page.waitForFunction(() => {
    const app = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    return !!app.doc.actions[app.activeObject.animation_data.action].fcurves[0].sampled_points;
  });
  const sp = await page.evaluate(() => {
    const app = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    return app.doc.actions[app.activeObject.animation_data.action].fcurves[0].sampled_points as [number, number][];
  });
  expect(sp.length).toBeGreaterThan(20);
  expect(sp[5][1]).toBeGreaterThan(0.3);
  expect(sp[sp.length - 1][1]).toBeLessThan(sp[5][1] / 4);
  await expectNoErrors(errors);
});

test('action editor: make markers local, then add pose markers', async ({ page }) => {
  const errors = await openApp(page);
  const box = await setup(page, 'DOPESHEET');
  await page.evaluate(async () => {
    const { shell } = await import('/src/ui/shell.ts');
    const app = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    shell.screen.areas.find((a: { type: string }) => a.type === 'DOPESHEET').editor.setMode('ACTION');
    app.doc.scene.timeline_markers.push({ name: 'Contact', frame: 5, select: true });
    app.changed('doc');
  });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await openHeaderMenu(page, area(page, 'DOPESHEET'), 'Marker');
  await page.locator('.menu-item', { hasText: 'Make Markers Local' }).click();
  const r = await page.evaluate(() => {
    const app = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    return [app.doc.scene.timeline_markers.length, app.doc.actions[app.activeObject.animation_data.action].pose_markers.map((m: { name: string }) => m.name)];
  });
  expect(r).toEqual([0, ['Contact']]);
  // with pose markers shown, M adds to the action
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.evaluate(() => (window as any).app.setFrame(12)); // eslint-disable-line @typescript-eslint/no-explicit-any
  await page.keyboard.press('M');
  expect(await page.evaluate(() => (window as any).app.doc.actions[(window as any).app.activeObject.animation_data.action].pose_markers.length)).toBe(2); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(await page.evaluate(() => (window as any).app.doc.scene.timeline_markers.length)).toBe(0); // eslint-disable-line @typescript-eslint/no-explicit-any
  await expectNoErrors(errors);
});
