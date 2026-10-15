import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

async function maskingWorkspace(page: Page) {
  const errors = await openApp(page);
  await page.evaluate(async () => {
    const { shell } = await import('/src/ui/shell.ts' as any);
    const { workspaceTemplates } = await import('/src/ui/screen.ts' as any);
    shell.addWorkspace(workspaceTemplates.find((t: any) => t.create().name === 'Masking').create());
  });
  await page.waitForTimeout(300);
  const box = (await page.locator('.clip-root').first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  return { errors, box };
}

/** Screen point of a mask-space position in the hovered clip editor. */
const at = (page: Page, u: number, v: number) =>
  page.evaluate(
    ([u, v]) => {
      const ed = (window as any).app.hoverArea.editor;
      const r = ed.el.getBoundingClientRect();
      const [W, H] = ed.frameSize();
      const p = ed.toScreen(u * W, (1 - v) * H);
      return { x: r.left + p[0], y: r.top + p[1] };
    },
    [u, v] as const,
  );
const mask = (page: Page) => page.evaluate(() => Object.values((window as any).app.doc.masks ?? {})[0] as any);

test('mask: new mask, Ctrl click draws a spline, Alt C closes it, G moves points, I keys the shape', async ({ page }) => {
  const { errors } = await maskingWorkspace(page);
  await page.keyboard.press('Alt+n');
  await page.keyboard.press('t');
  await page.keyboard.press('n');
  await page.keyboard.press('Home');
  for (const [u, v] of [
    [0.4, 0.4],
    [0.6, 0.4],
    [0.5, 0.65],
  ]) {
    const p = await at(page, u, v);
    await page.keyboard.down('Control');
    await page.mouse.click(p.x, p.y);
    await page.keyboard.up('Control');
  }
  let m = await mask(page);
  expect(m.layers[0].splines.map((s: any) => s.points.length)).toEqual([3]);
  const mid = await at(page, 0.5, 0.5);
  await page.mouse.move(mid.x, mid.y);
  await page.keyboard.press('Alt+c');
  await page.keyboard.press('a');
  await page.keyboard.press('g');
  await page.mouse.move(mid.x + 40, mid.y, { steps: 3 });
  await page.mouse.down();
  await page.mouse.up();
  m = await mask(page);
  expect(m.layers[0].splines[0].use_cyclic).toBe(true);
  expect(m.layers[0].splines[0].points[0].co[0]).toBeGreaterThan(0.41);
  await page.keyboard.press('i');
  m = await mask(page);
  expect(m.layers[0].shape_keys.length).toBe(1);
  // undo the key
  await page.keyboard.press('Control+z');
  expect((await mask(page)).layers[0].shape_keys.length).toBe(0);
  await expectNoErrors(errors);
});

test('mask: Add ▸ Circle, box select, delete, layers and the sequencer mask strip', async ({ page }) => {
  const { errors } = await maskingWorkspace(page);
  await page.locator('.clip-header .btn', { hasText: 'New' }).click();
  await page.locator('.clip-header .hdr-menu', { hasText: /^Add$/ }).dispatchEvent('pointerdown');
  await page.locator('.popup-layer .menu-item', { hasText: 'Circle' }).click();
  let m = await mask(page);
  expect(m.layers[0].splines[0].points.length).toBe(4);
  // deselect, then box select everything and delete
  await page.keyboard.press('Alt+a');
  const a = await at(page, 0.05, 0.05);
  const b = await at(page, 0.95, 0.95);
  await page.mouse.move(a.x, b.y);
  await page.mouse.down();
  await page.mouse.move(b.x, a.y, { steps: 4 });
  await page.mouse.up();
  m = await mask(page);
  expect(m.layers[0].splines[0].points.every((p: any) => p.select)).toBe(true);
  await page.keyboard.press('x');
  expect((await mask(page)).layers[0].splines.length).toBe(0);
  await page.keyboard.press('Control+z');
  expect((await mask(page)).layers[0].splines.length).toBe(1);
  // a mask strip shows it in the sequencer
  const id = (await mask(page)).id;
  await page.evaluate((id) => {
    const app = (window as any).app;
    app.run('sequencer.mask_strip_add', { mask: id, frame_start: 1, channel: 1 }, { invoke: false });
  }, id);
  const strip = await page.evaluate(() => (window as any).app.doc.scene.sequence_editor.strips[0]);
  expect([strip.type, strip.mask]).toEqual(['MASK', id]);
  await expectNoErrors(errors);
});

test('mask: points parented to a track (Ctrl P) follow it', async ({ page }) => {
  const { errors } = await maskingWorkspace(page);
  await page.evaluate(async () => {
    const T = await import('/src/tracking/types.ts' as any);
    const app = (window as any).app;
    const c = T.newMovieClip('MC_t', 'clip', { size: [640, 360], frame_duration: 20 });
    const t = T.newTrack(c.tracking, 'A');
    for (let f = 1; f <= 10; f++) t.markers.push(T.newMarker(f, [0.3 + f * 0.02, 0.5], c.size, 21, 71));
    c.tracking.tracks.push(t);
    c.tracking.active_track = t.name;
    T.clipTable(app.doc)['MC_t'] = c;
    app.hoverArea.editor.setClip('MC_t');
    app.run('mask.new');
    app.run('mask.primitive_square_add', { size: 0.2, location: [0.4, 0.5] });
    app.pushUndo('setup');
  });
  await page.keyboard.press('a');
  await page.keyboard.press('Control+p');
  const parented = await page.evaluate(() => (Object.values((window as any).app.doc.masks)[0] as any).layers[0].splines[0].points.every((p: any) => p.parent?.track === 'A'));
  expect(parented).toBe(true);
  await page.evaluate(() => (window as any).app.setFrame(6));
  const moved = await page.evaluate(async () => {
    const M = await import('/src/mask/clipmask.ts' as any);
    const m = Object.values((window as any).app.doc.masks)[0] as any;
    const E = M.shownPoints(m);
    const p = m.layers[0].splines[0].points[0];
    return E.get(p).co[0] - p.co[0];
  });
  expect(moved).toBeCloseTo(0.1, 5);
  await expectNoErrors(errors);
});

test('mask: a strip modifier limited to a mask only changes the inside', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(async () => {
    const { shell } = await import('/src/ui/shell.ts' as any);
    const { workspaceTemplates } = await import('/src/ui/screen.ts' as any);
    shell.addWorkspace(workspaceTemplates.find((t: any) => t.create().name === 'Video Editing').create());
    const app = (window as any).app;
    const { newMask, maskTable } = await import('/src/mask/types.ts' as any);
    const G = await import('/src/mask/geom.ts' as any);
    const m = newMask('MA_t', 'Spot');
    maskTable(app.doc)['MA_t'] = m;
    m.layers[0].splines.push(G.circleSpline(0.5, 0.5, 0.3, 16 / 9));
    app.run('sequencer.effect_strip_add', { type: 'COLOR', frame_start: 1, channel: 1, length: 40, color: [0.5, 0.5, 0.5] }, { invoke: false });
    app.run('sequencer.strip_modifier_add', { type: 'BRIGHT_CONTRAST' });
    const s = app.doc.scene.sequence_editor.strips[0];
    Object.assign(s.modifiers[0], { bright: 40, input_mask_type: 'ID', input_mask_id: 'MA_t' });
    app.changed('doc');
  });
  await page.waitForTimeout(1000);
  const pv = (await page.locator('.seq-pv').first().boundingBox())!;
  await page.mouse.move(pv.x + pv.width / 2, pv.y + pv.height / 2);
  const v = await page.evaluate(([cx, cy, x0, y0]) => {
    const pr = (window as any).app.hoverArea.editor.preview;
    return { inside: pr.sample(cx, cy)?.rgba[0], outside: pr.sample(x0, y0)?.rgba[0] };
  }, [pv.x + pv.width / 2, pv.y + pv.height / 2, pv.x + 30, pv.y + pv.height / 2] as const);
  expect(v.inside).toBeGreaterThan(v.outside + 0.2);
  await expectNoErrors(errors);
});

test('mask: point transforms can be adjusted afterwards', async ({ page }) => {
  const { errors } = await maskingWorkspace(page);
  await page.keyboard.press('Alt+n');
  await page.evaluate(() => (window as any).app.run('mask.primitive_square_add', { size: 0.2, location: [0.5, 0.5] }));
  const before = (await mask(page)).layers[0].splines[0].points[0].co;
  await page.keyboard.press('g');
  const c = (await page.locator('.clip-root').first().boundingBox())!;
  await page.mouse.move(c.x + c.width / 2 + 30, c.y + c.height / 2, { steps: 3 });
  await page.mouse.down();
  await page.mouse.up();
  expect(await page.evaluate(() => (window as any).app.lastOp?.idname)).toBe('mask.transform');
  await page.evaluate(() => (window as any).app.redoLast({ value: [0.1, 0.05, 0] }));
  const after = (await mask(page)).layers[0].splines[0].points[0].co;
  expect(after[0] - before[0]).toBeCloseTo(0.1, 6);
  expect(after[1] - before[1]).toBeCloseTo(0.05, 6);
  await expectNoErrors(errors);
});

test('mask: Shift right click places the 2D cursor; new shapes and the cursor pivot use it', async ({ page }) => {
  const { errors } = await maskingWorkspace(page);
  await page.keyboard.press('Alt+n');
  await page.keyboard.press('Home');
  const p = await at(page, 0.25, 0.75);
  await page.mouse.move(p.x, p.y);
  await page.keyboard.down('Shift');
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });
  await page.keyboard.up('Shift');
  const cur = await page.evaluate(() => (window as any).app.hoverArea.editor.cursor);
  expect(cur[0]).toBeCloseTo(0.25, 2);
  expect(cur[1]).toBeCloseTo(0.75, 2);
  await page.locator('.clip-header .hdr-menu', { hasText: /^Add$/ }).dispatchEvent('pointerdown');
  await page.locator('.popup-layer .menu-item', { hasText: 'Square' }).click();
  const pts = (await mask(page)).layers[0].splines[0].points.map((q: any) => q.co);
  const cx = pts.reduce((a: number, q: number[]) => a + q[0], 0) / 4;
  expect(cx).toBeCloseTo(0.25, 2);
  await expectNoErrors(errors);
});

test('mask: M moves the selected splines to a new layer; Ctrl Alt drag lassos points', async ({ page }) => {
  const { errors } = await maskingWorkspace(page);
  await page.keyboard.press('Alt+n');
  await page.keyboard.press('t');
  await page.keyboard.press('n');
  await page.keyboard.press('Home');
  await page.evaluate(() => (window as any).app.run('mask.primitive_square_add', { size: 0.2, location: [0.3, 0.5] }, { invoke: false }));
  await page.keyboard.press('m');
  await menuItemByText(page, 'New Layer').click();
  const m = await mask(page);
  expect(m.layers.map((l: any) => l.splines.length)).toEqual([0, 1]);
  // lasso around the square selects its points
  await page.keyboard.press('Alt+a');
  const a = await at(page, 0.1, 0.3),
    b = await at(page, 0.5, 0.3),
    c = await at(page, 0.5, 0.7),
    d = await at(page, 0.1, 0.7);
  await page.mouse.move(a.x, a.y);
  await page.keyboard.down('Control');
  await page.keyboard.down('Alt');
  await page.mouse.down();
  for (const q of [b, c, d, a]) await page.mouse.move(q.x, q.y, { steps: 3 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await page.keyboard.up('Control');
  expect((await mask(page)).layers[1].splines[0].points.every((p: any) => p.select)).toBe(true);
  await expectNoErrors(errors);
});

const menuItemByText = (page: Page, label: string) => page.locator('.popup-layer .menu-item', { has: page.locator('.mi-label', { hasText: new RegExp(`^${label}$`) }) }).last();
